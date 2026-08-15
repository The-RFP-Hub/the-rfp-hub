"use client";

/**
 * A boundary around the auth provider, because the failure it catches is a real one.
 *
 * The SDK validates its application id on the FIRST RENDER and throws if it does not like it. An
 * uncaught throw there takes the whole tree with it, and the framework's fallback for that is the
 * words "Application error: a client-side exception has occurred" — which tells an operator with a
 * mistyped `NEXT_PUBLIC_PRIVY_APP_ID` nothing at all. This was observed, not imagined: it is what
 * this dashboard did before the boundary existed.
 *
 * So the boundary names the variable, quotes the SDK's own message, and says the thing that is
 * actually true about this class of failure — that the value is baked in at build time, so fixing
 * the environment on the host is not enough.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class AuthBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept: the stack is what a developer needs, and there is no error-reporting service here to
    // send it to. Nothing user-identifying is logged — the message comes from the SDK.
    console.error("The dashboard could not start.", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="shell-main">
        <h1>The dashboard could not start</h1>
        <p className="state error" role="alert">
          {error.message}
        </p>
        <p>
          This almost always means <code>NEXT_PUBLIC_PRIVY_APP_ID</code> is wrong for this
          environment — a placeholder, or another environment&rsquo;s application. Each environment
          has its own; see <code>packages/dashboard/README.md</code>.
        </p>
        <p className="muted">
          The value is read when the dashboard is <strong>built</strong>. Correcting it on the
          running host changes nothing until the next build.
        </p>
      </main>
    );
  }
}
