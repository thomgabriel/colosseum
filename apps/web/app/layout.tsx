import { DISCLAIMER } from '@colosseum/schemas';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Colosseum — goal-based structuring',
  description: 'Policy in your wallet, not a fund.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen bg-white text-gray-900 antialiased">
        <main className="mx-auto max-w-4xl p-6">{children}</main>
        <footer className="mx-auto max-w-4xl p-6 text-xs text-gray-500">
          <p>{DISCLAIMER.pt}</p>
          <p className="mt-2">{DISCLAIMER.en}</p>
        </footer>
      </body>
    </html>
  );
}
