"use client";

/**
 * A boundary around the provider tree, because the failure it catches is a real one.
 *
 * It was added when a third-party SDK validated its application id on the first render and threw,
 * taking the whole tree with it — and the framework's fallback for that is the words "Application
 * error: a client-side exception has occurred", which tells an operator nothing at all. That SDK is
 * gone and so is that specific throw, but the boundary is NOT: any uncaught error during the first
 * render of the provider tree still produces the same useless fallback, and the class of cause is
 * the same one (a build-time value that is wrong for this environment).
 *
 * So the boundary quotes the real message and says the thing that is actually true about this class
 * of failure — that the configuration is baked in at build time, so fixing the environment on the
 * host is not enough.
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
    // send it to. Nothing user-identifying is logged, and nothing that could carry a session token:
    // the message is a render failure's, not a response body's.
    console.error("The frontend could not start.", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="shell-main">
        <h1>The frontend could not start</h1>
        <p className="state error" role="alert">
          {error.message}
        </p>
        <p>
          This usually means <code>NEXT_PUBLIC_API_URL</code> is wrong for this environment — a
          placeholder, or an origin this browser cannot reach. See{" "}
          <code>packages/frontend/README.md</code>.
        </p>
        <p className="muted">
          The value is read when the frontend is <strong>built</strong>. Correcting it on the
          running host changes nothing until the next build.
        </p>
      </main>
    );
  }
}
