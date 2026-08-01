export type FaqItem = {
  id: string;
  category: string;
  question: string;
  answer: string;
};

export const FAQ_ITEMS: FaqItem[] = [
  {
    id: "what-is-app",
    category: "시작하기",
    question: "Live MR Manager는 어떤 앱인가요?",
    answer:
      "방송·연습용 MR을 관리하는 Windows 데스크톱 앱입니다. 유튜브·로컬 음원 재생, AI로 MR 분리, 가사 동기화, OBS 오버레이 등을 한곳에서 다룰 수 있습니다. 음원 파일은 내 PC에서만 처리됩니다.",
  },
  {
    id: "what-is-site",
    category: "시작하기",
    question: "이 웹페이지는 무엇인가요?",
    answer:
      "Live MR Manager 공식 안내 사이트입니다. 앱 다운로드, 자주 묻는 질문, 문의 허브, 개인정보 처리방침·이용약관을 제공합니다.",
  },
  {
    id: "contact",
    category: "문의",
    question: "문의는 어디로 하면 되나요?",
    answer:
      "설치·사용법 질문은 Discord(https://discord.gg/qfJnk3VJyf) 또는 문의 허브(lmrm.vercel.app/qa)를 이용해 주세요. 재현 가능한 버그는 GitHub Issues 버그 신고 템플릿으로, 기능 제안은 기능 제안 템플릿으로 등록해 주세요. 토큰·비밀번호·전체 로그는 올리지 마세요.",
  },
  {
    id: "contact-privacy",
    category: "문의",
    question: "문의할 때 주의할 점은?",
    answer:
      "비밀번호, API Key, 개인 식별 정보, 전체 로그 파일은 공개 채널이나 Issues에 올리지 마세요. 버그 신고 시 앱 버전·Windows 버전·재현 단계만 적어도 충분한 경우가 많습니다.",
  },
  {
    id: "proficiency",
    category: "곡 정보",
    question: "숙련도와 난이도란?",
    answer:
      "1~5 단계입니다. 숙련도는 내가 그 곡을 얼마나 잘 부르는지, 난이도는 곡 자체가 얼마나 어려운지를 나타냅니다. 앱 곡 정보 편집에서 별을 클릭해 설정할 수 있습니다.",
  },
  {
    id: "key-bpm",
    category: "곡 정보",
    question: "KEY와 BPM은 어떻게 넣나요?",
    answer:
      "앱에서 곡 정보를 열고 KEY·BPM을 직접 입력하거나, 「KEY/BPM 분석」으로 자동 추정할 수 있습니다.",
  },
  {
    id: "privacy",
    category: "안전·개인정보",
    question: "내 음원이 인터넷으로 올라가나요?",
    answer:
      "아니요. MR 분리·재생에 쓰는 음원 파일은 PC 안에서만 처리됩니다. 앱이 외부로 보내는 것은 사용자가 명시적으로 사용하는 기능(업데이트 확인, 유튜브 메타데이터 조회 등)에 필요한 요청뿐입니다.",
  },
];

export const FAQ_CATEGORIES = [
  "전체",
  ...Array.from(new Set(FAQ_ITEMS.map((item) => item.category))),
];
