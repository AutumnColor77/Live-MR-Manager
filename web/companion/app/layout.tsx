import type { Metadata } from "next";
import "./globals.css";
import { SiteFooter } from "@/components/SiteFooter";
import { SITE_ICON, SITE_NAME } from "@/lib/site";

export const metadata: Metadata = {
  title: {
    default: `${SITE_NAME} — 공식 Companion`,
    template: `%s · ${SITE_NAME}`,
  },
  description:
    "Live MR Manager 설치, FAQ, 다운로드 및 법적 문서 안내.",
  icons: {
    icon: SITE_ICON,
    apple: SITE_ICON,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
