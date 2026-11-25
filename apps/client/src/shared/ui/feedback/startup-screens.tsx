/**
 * Last-resort screens shown instead of a blank page. They use inline styles
 * and plain elements only (no Tailwind, HeroUI or i18n), because the thing
 * that failed may be exactly one of those.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

const page: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "1rem",
  padding: "2rem",
  fontFamily: "system-ui, -apple-system, sans-serif",
  textAlign: "center",
};

const code: React.CSSProperties = {
  fontFamily: "ui-monospace, Menlo, monospace",
  fontSize: "0.9rem",
  padding: "0.75rem 1rem",
  borderRadius: "6px",
  maxWidth: "48rem",
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  textAlign: "left",
};

export function EnvMissingScreen({ missing }: { missing: readonly string[] }) {
  return (
    <div
      role="alert"
      style={{ ...page, background: "#dc2626", color: "#ffffff" }}
    >
      <h1 style={{ fontSize: "2rem", fontWeight: 700, margin: 0 }}>
        Environment Variables Missing. Please check your .env file.
      </h1>
      <p style={{ margin: 0, fontSize: "1.1rem" }}>
        Not set at build time: <strong>{missing.join(", ")}</strong>
      </p>
      <pre style={{ ...code, background: "rgba(0,0,0,0.25)" }}>
        {`# Values with spaces must be quoted, and no <angle brackets>:
API_BASE_URL=http://localhost:8787
STORE_URL=http://localhost:5173
STORE_NAME="Bengali Exchange"

# Then restart the dev server (Vite reads these only at startup).`}
      </pre>
    </div>
  );
}

export function CrashScreen({ error }: { error: unknown }) {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error ?? "Unknown error");

  return (
    <div
      role="alert"
      style={{ ...page, background: "#fff7ed", color: "#7c2d12" }}
    >
      <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: 0 }}>
        Something went wrong. Check the console.
      </h1>
      <pre style={{ ...code, background: "#ffedd5" }}>{message}</pre>
      <button
        style={{
          padding: "0.6rem 1.25rem",
          borderRadius: "6px",
          border: "1px solid #7c2d12",
          background: "#7c2d12",
          color: "#ffffff",
          cursor: "pointer",
          fontSize: "1rem",
        }}
        type="button"
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  );
}

interface BoundaryState {
  error: unknown;
  hasError: boolean;
}

/** Catches render errors anywhere below it and shows CrashScreen. */
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  BoundaryState
> {
  state: BoundaryState = { error: null, hasError: false };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error, hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // eslint-disable-next-line no-console -- the fallback tells users to look here
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) return <CrashScreen error={this.state.error} />;

    return this.props.children;
  }
}
