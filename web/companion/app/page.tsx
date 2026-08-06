import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";

export default function HomePage() {
  return (
    <>
      <SiteHeader currentPath="/" />
      <main>
        <section className="hero">
          <span className="badge">퍼포머를 위한 MR 관리</span>
          <h1>연습·방송은 앱에서, 안내는 Companion에서</h1>
          <p>
            Live MR Manager로 MR·가사·재생을 관리하세요. 음원은 내 PC에서만
            다루고, 설치·사용법은 이 사이트에서 확인할 수 있습니다.
          </p>
        </section>

        <section className="card-grid">
          <article className="card">
            <h2>앱 받기</h2>
            <p>
              Windows용 Live MR Manager를 설치하고 라이브러리에 곡을 담아 보세요.
            </p>
            <Link href="/download" className="btn btn-primary">
              다운로드
            </Link>
          </article>
          <article className="card">
            <h2>도움이 필요하신가요?</h2>
            <p>설치, 라이브러리, MR 분리 등 자주 묻는 질문을 모았습니다.</p>
            <Link href="/faq" className="btn btn-secondary">
              FAQ 보기
            </Link>
          </article>
        </section>

        <section style={{ marginTop: "2.5rem" }}>
          <h2 style={{ margin: "0 0 1rem", fontSize: "1.15rem" }}>
            이렇게 사용해 보세요
          </h2>
          <ol className="steps">
            <li>
              <strong>1. 앱 설치</strong>
              <span>
                <Link href="/download">다운로드</Link> 페이지에서 최신 버전을
                설치합니다.
              </span>
            </li>
            <li>
              <strong>2. 곡 라이브러리 만들기</strong>
              <span>
                유튜브 검색·URL 또는 로컬 파일로 곡을 추가하고, 필요하면 AI로 MR을 분리해 둡니다. Songbook에 로그인하면 채널 노래책으로 보낼 수 있습니다.
              </span>
            </li>
            <li>
              <strong>3. 곡 정보 정리</strong>
              <span>
                제목·가수·KEY/BPM·가사 등을 정리해 방송·연습에 맞게 관리합니다.
              </span>
            </li>
            <li>
              <strong>4. 방송·연습</strong>
              <span>
                앱에서 재생·피치 조절·OBS 오버레이를 사용합니다.
              </span>
            </li>
          </ol>
        </section>
      </main>
    </>
  );
}
