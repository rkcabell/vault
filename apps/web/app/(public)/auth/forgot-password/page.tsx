"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "../authpage.module.css";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const resetUrl =
    resetToken && typeof window !== "undefined"
      ? `${window.location.origin}/auth/reset-password?token=${resetToken}`
      : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = res.ok ? await res.json() : {};
      setResetToken(data.token ?? null);
    } catch {
      setResetToken(null);
    } finally {
      setLoading(false);
      setDone(true);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <div className={styles.textCenter}>
          <h1 className={styles.title}>Forgot Password</h1>
          <p className={styles.subtitle}>
            {done ? "Your reset link is ready" : "Enter your email to get a reset link"}
          </p>
        </div>

        {!done ? (
          <form onSubmit={handleSubmit} noValidate>
            <div className={styles.formGroup}>
              <label htmlFor="email" className={styles.label}>Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={styles.input}
                placeholder="you@example.com"
                required
              />
            </div>
            <button type="submit" className={styles.submitBtn} disabled={loading || !email.includes("@")}>
              {loading ? "Generating link..." : "Get reset link"}
            </button>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => router.push("/auth")}
              disabled={loading}
            >
              Back to sign in
            </button>
          </form>
        ) : (
          <div>
            {resetUrl ? (
              <div>
                <p className={styles.fieldHint} style={{ marginBottom: "1rem", fontSize: "0.9rem" }}>
                  Click the link below to reset your password. It expires in 1 hour.
                </p>
                <a
                  href={resetUrl}
                  className={styles.submitBtn}
                  style={{ display: "block", textAlign: "center", textDecoration: "none" }}
                >
                  Reset my password
                </a>
              </div>
            ) : (
              <p className={styles.fieldHint} style={{ fontSize: "0.9rem", textAlign: "center" }}>
                If that email is registered, a reset link would appear here.
              </p>
            )}
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => router.push("/auth")}
            >
              Back to sign in
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
