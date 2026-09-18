import { Component, useEffect, useState, type ReactNode } from "react";
import { RunsPage } from "./pages/RunsPage.tsx";
import { RunDetailPage } from "./pages/RunDetailPage.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";
import { MetricsPage } from "./pages/MetricsPage.tsx";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <p className="error">Console crashed: {this.state.error.message}</p>;
    }
    return this.props.children;
  }
}

type Route =
  | { name: "runs" }
  | { name: "run"; id: string }
  | { name: "tasks" }
  | { name: "metrics" };

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "tasks") {
    return { name: "tasks" };
  }
  if (parts[0] === "metrics") {
    return { name: "metrics" };
  }
  if (parts[0] === "runs" && parts[1]) {
    return { name: "run", id: parts[1] };
  }
  return { name: "runs" };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          Drass<span>os</span>
        </div>
        <nav className="nav">
          <a href="#/" className={route.name === "runs" || route.name === "run" ? "active" : ""}>
            Runs
          </a>
          <a href="#/tasks" className={route.name === "tasks" ? "active" : ""}>
            Human tasks
          </a>
          <a href="#/metrics" className={route.name === "metrics" ? "active" : ""}>
            Metrics
          </a>
        </nav>
      </header>
      <ErrorBoundary>
        {route.name === "runs" && <RunsPage />}
        {route.name === "run" && <RunDetailPage id={route.id} />}
        {route.name === "tasks" && <TasksPage />}
        {route.name === "metrics" && <MetricsPage />}
      </ErrorBoundary>
    </div>
  );
}
