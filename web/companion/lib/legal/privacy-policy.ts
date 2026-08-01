export const PRIVACY_EFFECTIVE_DATE = "2026년 8월 1일";

export const GITHUB_ISSUES_URL =
  "https://github.com/AutumnColor77/Live-MR-Manager/issues";

export const QA_URL = "https://lmrm.vercel.app/qa";

export type LegalTable = {
  headers: string[];
  rows: string[][];
};

export type LegalSection = {
  id: string;
  title: string;
  paragraphs?: string[];
  list?: string[];
  table?: LegalTable;
  note?: string;
};

export const PRIVACY_SECTIONS: LegalSection[] = [
  {
    id: "intro",
    title: "1. 총칙",
    paragraphs: [
      "Live MR Manager(이하 「서비스」)는 Windows 데스크톱 앱과 Companion 웹사이트(lmrm.vercel.app)를 통해 방송·연습용 MR 관리 안내, 다운로드, FAQ·법적 문서를 제공합니다.",
      "본 개인정보 처리방침은 서비스 이용 과정에서 처리되는 정보의 범위, 목적, 보유 기간 등을 설명합니다.",
      "개인정보 처리자: 개인 개발자 AutumnColor77",
      `시행일: ${PRIVACY_EFFECTIVE_DATE}`,
      `일반 문의·커뮤니티: 문의 허브(${QA_URL}) 및 Discord(해당 페이지 안내). Discord 대화는 운영 목적으로 확인될 수 있으니 토큰·비밀번호 등 민감 정보는 올리지 마세요.`,
      `개인정보·공식 버그 신고: GitHub Issues (${GITHUB_ISSUES_URL})`,
    ],
  },
  {
    id: "items",
    title: "2. 처리하는 개인정보 항목",
    paragraphs: [
      "서비스는 별도의 회원가입을 운영하지 않습니다. Companion 웹 이용 및 데스크톱 앱 기능 사용 여부에 따라 아래 정보가 처리될 수 있습니다.",
      "Live MR Manager는 MR 분리·재생에 사용하는 음원 파일을 서버에 업로드하지 않습니다.",
    ],
    list: [
      "Companion 웹 접속 시: IP 주소, User-Agent 등 접속 로그(Vercel 호스팅 기본 로그)",
      "데스크톱 앱 — 메타데이터 검색 기능 사용 시: 곡·아티스트 검색어(Last.fm API, 운영자 Cloudflare Workers 경유)",
      "데스크톱 앱 — 업데이트 확인 시: 앱 버전 정보(GitHub Releases 조회)",
      "로컬 전용(외부 미전송): 음원 파일, AI MR 분리 결과, 라이브러리 메타데이터, OBS 오버레이용 재생 정보(동일 PC·LAN 내)",
    ],
  },
  {
    id: "purpose",
    title: "3. 개인정보의 처리 목적",
    list: [
      "Companion 웹 FAQ·다운로드·법적 문서 제공",
      "데스크톱 앱 업데이트 안내(GitHub Releases)",
      "곡 메타데이터 검색 보조(Last.fm — 기능 사용 시에만)",
      "서비스 안정성·보안(접속 로그 등)",
    ],
  },
  {
    id: "retention",
    title: "4. 보유 및 이용 기간",
    list: [
      "곡 메타·라이브러리(앱): 로컬 SQLite(library.db)에 저장, 사용자가 삭제·앱 제거 시까지",
      "Companion 웹 접속 로그: Vercel 호스팅 정책에 따름(별도 회원 DB 미저장)",
    ],
  },
  {
    id: "third-party",
    title: "5. 제3자 제공 및 처리 위탁",
    paragraphs: [
      "Last.fm: 데스크톱 앱에서 메타데이터 검색 기능을 사용할 때, 운영자가 운영하는 Cloudflare Workers를 경유하여 Last.fm API에 곡·아티스트 검색어가 전송됩니다. 해당 기능을 사용하지 않으면 Last.fm으로 데이터가 전송되지 않습니다.",
    ],
    table: {
      headers: ["수탁·연동 대상", "목적", "전송·처리 항목"],
      rows: [
        ["Vercel", "Companion 웹 호스팅", "접속 로그"],
        [
          "Cloudflare(Workers)",
          "Last.fm API 중계",
          "곡·아티스트 검색어(기능 사용 시)",
        ],
        ["Last.fm", "음악 메타 조회", "곡·아티스트 검색어(기능 사용 시)"],
        ["GitHub", "릴리즈·업데이트 정보", "앱 버전 조회"],
        [
          "HuggingFace",
          "AI 모델 다운로드",
          "모델 파일 요청(개인 식별 정보 없음)",
        ],
      ],
    },
  },
  {
    id: "overseas",
    title: "6. 개인정보의 국외 이전",
    paragraphs: [
      "Vercel, Cloudflare, GitHub, HuggingFace, Last.fm 등 해외에 서버를 둔 서비스를 이용할 수 있습니다. 각 서비스의 정책에 따라 정보가 해당 국가에서 처리될 수 있습니다.",
    ],
  },
  {
    id: "rights",
    title: "7. 정보주체의 권리",
    paragraphs: [
      "개인정보 열람·정정·삭제·처리 정지 등을 요청하실 수 있습니다. GitHub Issues로 문의해 주세요.",
      "로컬 데이터 삭제: Windows에서 %LOCALAPPDATA%\\com.autumncolor77.live-mr-manager\\ 폴더를 삭제하면 앱 로컬 데이터(라이브러리·캐시 등)가 제거됩니다.",
    ],
  },
  {
    id: "cookies",
    title: "8. 쿠키 및 유사 기술(Companion 웹)",
    paragraphs: [
      "Companion 웹은 마케팅·행동 분석용 쿠키를 사용하지 않으며, 별도의 로그인·세션 쿠키를 운영하지 않습니다.",
    ],
  },
  {
    id: "security",
    title: "9. 개인정보의 안전성 확보 조치",
    list: [
      "Companion 웹 HTTPS(production) 적용",
      "음원·MR 분리 결과는 사용자 PC 로컬에서만 처리",
      "라이브러리 데이터는 데스크톱 앱 로컬 SQLite에 저장",
    ],
  },
  {
    id: "children",
    title: "10. 아동의 개인정보",
    paragraphs: [
      "서비스는 만 14세 미만 아동을 대상으로 하지 않습니다. 만 14세 미만 아동의 개인정보가 처리된 사실을 알게 된 경우, 지체 없이 삭제 등 필요한 조치를 하겠습니다.",
    ],
  },
  {
    id: "changes",
    title: "11. 개인정보 처리방침 변경",
    paragraphs: [
      "본 방침을 변경하는 경우 Companion 웹에 게시하고 시행일을 명시합니다. 중요한 변경은 페이지 상단 또는 공지를 통해 안내할 수 있습니다.",
      "서비스 이용 조건은 [이용약관](/terms)을 참고해 주세요.",
    ],
  },
];
