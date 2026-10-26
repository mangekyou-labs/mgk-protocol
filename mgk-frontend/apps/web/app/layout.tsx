import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { MaintenanceScreen } from '@/components/layout/MaintenanceScreen';

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
  title: 'mgk — Demo maintenance',
  description: 'The MGK devnet demo is being rebuilt. Trading is unavailable during maintenance.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // This immutable rollback build deliberately never mounts live route content.
  // Removing maintenance requires a reviewed source change, not an env toggle.
  void children;
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <MaintenanceScreen />
      </body>
    </html>
  );
}
