import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import Script from 'next/script';
import { AuthProvider } from '@/lib/auth/auth-context';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'DoppelSpotter',
  description: 'AI-powered brand protection for SMEs.',
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans text-gray-800 antialiased bg-white" suppressHydrationWarning>
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-V6LJ15MRBW"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-V6LJ15MRBW');
          `}
        </Script>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
