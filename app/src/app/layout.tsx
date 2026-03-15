import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import Script from 'next/script';
import { AuthProvider } from '@/lib/auth/auth-context';
import { CookieBanner } from '@/components/cookie-banner';
import { GaPageTracker } from '@/components/ga-page-tracker';
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

const consoleTimestampBootstrapScript = `(() => {
  const consoleObject = window.console;
  const installedKey = '__doppelspotterConsoleTimestampsInstalled';
  if (consoleObject[installedKey]) {
    return;
  }

  consoleObject[installedKey] = true;

  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  const formatTimestamp = () => {
    const now = new Date();
    return '[' + [
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds()),
    ].join(':') + '.' + pad(now.getMilliseconds(), 3) + ']';
  };

  for (const method of methods) {
    const original = consoleObject[method].bind(consoleObject);
    consoleObject[method] = (...args) => {
      const prefix = formatTimestamp();

      if (args.length === 0) {
        original(prefix);
        return;
      }

      const [first, ...rest] = args;
      if (typeof first === 'string') {
        original(prefix + ' ' + first, ...rest);
        return;
      }

      original(prefix, first, ...rest);
    };
  }
})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans text-gray-800 antialiased bg-white" suppressHydrationWarning>
        {process.env.NODE_ENV === 'development' ? (
          <Script id="console-timestamps" strategy="beforeInteractive">
            {consoleTimestampBootstrapScript}
          </Script>
        ) : null}
        <Script id="ga-consent-guard" strategy="beforeInteractive">
          {`try{if(localStorage.getItem('cookie_consent')==='rejected'){window['ga-disable-G-V6LJ15MRBW']=true;}}catch(e){}`}
        </Script>
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-V6LJ15MRBW"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-V6LJ15MRBW', { send_page_view: false });
          `}
        </Script>
        <AuthProvider>{children}</AuthProvider>
        <GaPageTracker />
        <CookieBanner />
      </body>
    </html>
  );
}
