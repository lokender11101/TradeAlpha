import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '@/lib/auth-context';
import { SocketProvider } from '@/lib/socket-context';
import { Toaster } from '@/components/ui/toast';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'TradeAlpha',
  description: 'High-performance trading platform',
};

import { Navbar } from '@/components/layout/navbar';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} min-h-screen bg-background text-foreground antialiased flex flex-col`}>
        <AuthProvider>
          <SocketProvider>
            <Navbar />
            <main className="flex-1 flex flex-col">
              {children}
            </main>
            <Toaster />
          </SocketProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
