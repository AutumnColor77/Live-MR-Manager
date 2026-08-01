"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { FAQ_CATEGORIES, FAQ_ITEMS } from "@/lib/faq-data";

function FaqAnswer({ id, answer }: { id: string; answer: string }) {
  if (id === "privacy") {
    return (
      <p>
        아니요. MR 분리·재생에 쓰는 음원 파일은 PC 안에서만 처리됩니다. 자세한
        내용은 <Link href="/privacy">개인정보 처리방침</Link>을 참고해 주세요.
      </p>
    );
  }
  return <p>{answer}</p>;
}

export function FaqList() {
  const [category, setCategory] = useState("전체");

  const items = useMemo(() => {
    if (category === "전체") return FAQ_ITEMS;
    return FAQ_ITEMS.filter((item) => item.category === category);
  }, [category]);

  return (
    <>
      <div className="filter-row" role="tablist" aria-label="FAQ 카테고리">
        {FAQ_CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            className={`chip ${category === cat ? "chip-active" : ""}`}
            onClick={() => setCategory(cat)}
          >
            {cat}
          </button>
        ))}
      </div>
      <div className="faq-list">
        {items.map((item) => (
          <article key={item.id} className="faq-item" id={item.id}>
            <div className="faq-meta">{item.category}</div>
            <h3>{item.question}</h3>
            <FaqAnswer id={item.id} answer={item.answer} />
          </article>
        ))}
      </div>
    </>
  );
}
