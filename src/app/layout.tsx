import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Internship Tracker",
  description: "Polls internship sources, scores, and alerts via Discord.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full">
        <main className="min-h-full overflow-x-hidden overflow-y-auto">{children}</main>
        <footer className="px-4 py-3 text-center text-xs text-muted-foreground">
          built by{" "}
          <a
            href="https://charliexue.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 hover:underline"
          >
            charlie xue
          </a>
        </footer>
      </body>
    </html>
  );
}
