import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "WebM to MP4 Dönüştürücü | Ücretsiz ve Güvenli",
  description: "WebM videolarınızı herhangi bir sunucuya yüklemeden, tarayıcınızda ücretsiz olarak MP4 formatına dönüştürün.",
  keywords: ["WebM", "MP4", "dönüştürücü", "video dönüştürme", "tarayıcı"],
  authors: [{ name: "WebM2MP4" }],
  openGraph: {
    title: "WebM to MP4 Dönüştürücü | Ücretsiz ve Güvenli",
    description: "WebM videolarınızı herhangi bir sunucuya yüklemeden, tarayıcınızda ücretsiz olarak MP4 formatına dönüştürün.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="tr" className={inter.variable}>
      <body className="min-h-screen font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
