import { type ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[calc(100svh-5rem)] w-full max-w-xl flex-col justify-center gap-6 py-8 sm:gap-8 [&>h1]:text-center [&>h1]:text-3xl [&>h1]:font-extrabold sm:[&>h1]:text-4xl [&>h2]:text-2xl [&>h2]:font-bold [&>a]:self-center">
      <img
        src="/images/180icon.png"
        alt="ご褒美ポケットのマスコット"
        width="180"
        height="180"
        className="mx-auto h-32 w-32 object-contain sm:h-40 sm:w-40"
      />
      {children}
    </div>
  );
}
