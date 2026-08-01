import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { GITHUB_RELEASES_URL } from "@/lib/site";

export const metadata = {
  title: "다운로드",
  description: "Live MR Manager Windows 앱 다운로드",
};

export default function DownloadPage() {
  return (
    <>
      <SiteHeader currentPath="/download" />
      <main>
        <section className="hero">
          <span className="badge">Windows</span>
          <h1>Live MR Manager 받기</h1>
          <p>
            PC에 설치한 뒤 MR 라이브러리를 만들고, 방송·연습에 맞게 곡을
            관리할 수 있습니다.
          </p>
        </section>
        <article className="card">
          <h2>최신 버전 설치</h2>
          <p>
            아래 버튼에서 설치 파일을 받을 수 있습니다. 설치 후 유튜브·로컬
            음원을 추가해 라이브러리를 시작해 보세요.
          </p>
          <a
            href={GITHUB_RELEASES_URL}
            className="btn btn-primary"
            target="_blank"
            rel="noopener noreferrer"
          >
            설치 파일 다운로드
          </a>
        </article>
        <article className="card" style={{ marginTop: "1rem" }}>
          <h2>설치 후</h2>
          <p>
            곡을 추가하고 AI MR 분리, 가사 동기화, OBS 오버레이 등 앱 기능을
            활용할 수 있습니다.
          </p>
          <Link href="/faq" className="btn btn-secondary">
            사용 방법 보기
          </Link>
        </article>
      </main>
    </>
  );
}
