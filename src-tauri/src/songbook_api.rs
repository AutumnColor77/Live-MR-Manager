use serde::{Deserialize, Serialize};

const HTTP_TIMEOUT_SECS: u64 = 30;
const ALLOWED_METHODS: &[&str] = &["GET", "POST", "PATCH", "PUT", "DELETE"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongbookHttpRequest {
    pub method: String,
    pub url: String,
    pub token: Option<String>,
    pub body: Option<String>,
    pub content_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongbookHttpResponse {
    pub status: u16,
    pub body: String,
    pub ok: bool,
}

fn validate_method(method: &str) -> Result<&str, String> {
    let upper = method.trim().to_uppercase();
    ALLOWED_METHODS
        .iter()
        .find(|m| **m == upper)
        .copied()
        .ok_or_else(|| "허용되지 않은 HTTP 메서드입니다.".into())
}

#[tauri::command]
pub async fn songbook_http(req: SongbookHttpRequest) -> Result<SongbookHttpResponse, String> {
    let method = validate_method(&req.method)?;
    let url = crate::ipc_validate::validate_songbook_api_url(&req.url)?;
    if let Some(body) = req.body.as_deref() {
        crate::ipc_validate::require_max_len(
            body,
            crate::ipc_validate::MAX_SONGBOOK_API_BODY_LEN,
            "body",
        )?;
    }
    let token = req
        .token
        .as_deref()
        .map(crate::ipc_validate::validate_session_token)
        .transpose()?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Songbook 클라이언트를 준비하지 못했습니다. ({e})"))?;

    let http_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| "허용되지 않은 HTTP 메서드입니다.".to_string())?;

    let mut builder = client.request(http_method, &url);
    if let Some(token) = token {
        builder = builder.bearer_auth(token);
    }
    if let Some(body) = req.body {
        let content_type = req
            .content_type
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "application/json".to_string());
        builder = builder.header(reqwest::header::CONTENT_TYPE, content_type);
        builder = builder.body(body);
    }

    let response = builder
        .send()
        .await
        .map_err(|_| "Songbook 서버에 연결하지 못했습니다.".to_string())?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|_| "Songbook 응답을 읽지 못했습니다.".to_string())?;

    Ok(SongbookHttpResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body,
    })
}
