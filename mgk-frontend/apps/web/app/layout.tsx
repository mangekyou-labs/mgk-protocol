import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Header } from '@/components/layout/Header';
import { SolanaProvider } from '@/components/providers/SolanaProvider';
import { ThemeProvider } from '@/components/providers/ThemeProvider';


const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'mgk — On-chain perps',
  description: 'On-chain perpetual futures with dual-flow batch auctions (DFBA). Devnet.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <SolanaProvider>
            <Header />
            <div className="flex-1 flex flex-col min-h-0">
              {children}
            </div>
          </SolanaProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
