"use client";
import { useState } from "react";
import Link from "next/link";

const MESSAGES = [
  "It wandered off. We've filed a missing pages report.",
  "This page called in sick today.",
  "Gone. Vanished. Poof. Very rude of it.",
  "We looked everywhere. Under the couch, behind the fridge. Nothing.",
  "This page is in another castle.",
  "Technically this page exists. Just not here. Or anywhere.",
  "Our intern was supposed to make this page. Long story.",
  "Not all who wander are lost. This page is lost.",
  "This page was here and then it simply wasn't. We're all a little shaken.",
  "This page is taking a break. We don't know when it'll be back.",
  "That page doesn't exist. But if it did, it would be really cool. Maybe cooler than this one.",
];

export default function NotFound() {
  const [message] = useState(() => MESSAGES[Math.floor(Math.random() * MESSAGES.length)]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 text-center">
      <div className="space-y-2">
        <p className="text-8xl font-black tracking-tighter text-muted-foreground/20 select-none">
          404
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          Nothing to see here
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
      </div>

      <div className="flex items-center gap-3">
        <Link
          href="/library"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Go to Library
        </Link>
        <Link
          href="/overview"
          className="rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
        >
          Overview
        </Link>
      </div>
    </div>
  );
}
