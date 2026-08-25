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
 * So the boundary gives the reader a plain deployment-level state, then keeps the real message and
 * build-time configuration diagnosis in a technical disclosure.
 */
import { TechnicalDetails } from "@/components/states";
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
        <div className="state error" role="alert">
          <h1>This deployment cannot reach its service.</h1>
          <p>The application could not start. Try again after the deployment is fixed.</p>
          <TechnicalDetails error={error}>
            <p>
              Check <code>NEXT_PUBLIC_API_URL</code> and <code>packages/frontend/README.md</code>.
              The value is read when the frontend is built, so changing the running host requires a
              new build.
            </p>
          </TechnicalDetails>
        </div>
      </main>
    );
  }
}
