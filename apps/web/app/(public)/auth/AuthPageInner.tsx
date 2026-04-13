// File: app/(public)/auth/page.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { useAuth } from "@/components/contexts/AuthContext";
import { ThemeToggle } from "@/components/common/ThemeToggle";
import styles from "./authpage.module.css";

export default function AuthPage() {
  const router = useRouter();
  const { refresh } = useAuth();

  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const isRegister = mode === "register";

  const validate = () => {
    const errors: { email?: string; password?: string } = {};
    if (!email.includes("@")) errors.email = "Please enter a valid email address.";
    if (!password || password.length < 8) {
      errors.password = "Password must be at least 8 characters.";
    }
    return errors;
  };

  const getErrorMessage = async (response: Response, fallback: string) => {
    try {
      const data = await response.json();
      if (data?.message || data?.error) return data.message || data.error;
    } catch {
      // Ignore JSON parse errors and use fallback.
    }
    return `${fallback} (${response.status})`;
  };

  const toggleMode = () => {
    setMode((prev) => (prev === "login" ? "register" : "login"));
    setError("");
    setFieldErrors({});
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setError("");
    setFieldErrors({});

    const errors = validate();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setLoading(true);

    try {
      const endpoint = isRegister ? "/api/auth/register" : "/api/auth/login";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const msg = await getErrorMessage(
          response,
          isRegister ? "Registration failed. Please try again." : "Login failed. Please try again.",
        );
        setError(msg);
        return;
      }

      if (isRegister) {
        const loginResponse = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ email, password }),
        });

        if (!loginResponse.ok) {
          const msg = await getErrorMessage(
            loginResponse,
            "Registration succeeded, but login failed. Please sign in.",
          );
          setError(msg);
          return;
        }
      }

      await refresh();
      router.push("/overview");
    } catch {
      setError("Network error. Please check your connection.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.themeToggle}><ThemeToggle /></div>
      <div className={styles.card}>
        <div className={styles.textCenter}>
          <h1 className={styles.title}>{isRegister ? "Create Account" : "Sign In"}</h1>
          <p className={styles.subtitle}>
            {isRegister ? "Create your Vault account" : "Welcome to Vault"}
          </p>
        </div>

        {error && (
          <div className={styles.alert} role="alert">
            {/* svg... */}
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          <div className={styles.formGroup}>
            <label htmlFor="email" className={styles.label}>Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => { //Remove error while typing
                const v = e.target.value;
                setEmail(v);
                if (fieldErrors.email) {
                  setFieldErrors((prev) => ({ ...prev, email: undefined }));
                }
              }}
              className={`${styles.input} ${fieldErrors.email ? styles.inputError : ""}`}
              placeholder="you@example.com"
            />
            {fieldErrors.email && <div className={styles.fieldError}>{fieldErrors.email}</div>}
          </div>

          <div className={styles.formGroup}>
            <label htmlFor="password" className={styles.label}>Password</label>
            <div className={styles.inputWrapper}>
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => { //Remove error while typing
                  const v = e.target.value;
                  setPassword(v);
                  if (fieldErrors.password) {
                    setFieldErrors((prev) => ({ ...prev, password: undefined }));
                  }
                }}
                className={`${styles.input} ${fieldErrors.password ? styles.inputError : ""}`}
                placeholder="••••••••"
              />
              <button
                type="button"
                className={styles.togglePassword}
                onClick={() => setShowPassword((v) => !v)}
                disabled={loading}
                tabIndex={-1}
                aria-label={showPassword ? "Hide password" : "Show password"}
              // ...
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {fieldErrors.password
              ? <div className={styles.fieldError}>{fieldErrors.password}</div>
              : isRegister && <p className={styles.fieldHint}>Must be at least 8 characters.</p>
            }
            {!isRegister && (
              <button
                type="button"
                className={styles.forgotPassword}
                onClick={() => router.push("/auth/forgot-password")}
                disabled={loading}
              >
                Forgot password?
              </button>
            )}
          </div>

          <button type="submit" className={styles.submitBtn} disabled={loading}>
            {loading
              ? isRegister
                ? "Creating account..."
                : "Signing in..."
              : isRegister
                ? "Create account"
                : "Continue"}
          </button>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={toggleMode}
            disabled={loading}
          >
            {isRegister ? "Already have an account? Sign in" : "New here? Create an account"}
          </button>
        </form>
      </div>
    </div>
  );
}
