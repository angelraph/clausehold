import { Component, type ReactNode } from "react";

/**
 * If one page throws, show a short message in its place and keep the nav,
 * footer and every other page working. Keyed by path in main.tsx, so moving
 * to another page clears the error.
 */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Clausehold page error", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="wrap page-head" style={{ maxWidth: 640 }}>
        <div className="eyebrow">Something went wrong</div>
        <h1 className="h2" style={{ marginTop: 12 }}>This page could not load</h1>
        <p className="muted">The rest of the site still works. Try again, or pick another page from the menu.</p>
        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          <button className="btn btn-primary btn-sm" onClick={() => location.reload()}>Try again</button>
          <a className="btn btn-ghost btn-sm" href="/">Go to the home page</a>
        </div>
      </div>
    );
  }
}
