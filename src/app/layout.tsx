import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'GitHub Issue Summary: a repository at a glance',
  description:
    'Paste a GitHub repository URL to get its open issues summarised into themes, what needs attention and what is unanswered, plus an overall status score.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
