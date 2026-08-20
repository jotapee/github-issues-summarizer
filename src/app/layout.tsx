import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Issue TL;DR: summarise any GitHub issue tracker',
  description:
    'Paste a GitHub repository URL and get a short, powerful summary of its open issues and the discussions on them.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
