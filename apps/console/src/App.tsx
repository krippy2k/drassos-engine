import { useEffect, useState } from "react";
import { RunsPage } from "./pages/RunsPage.tsx";
import { RunDetailPage } from "./pages/RunDetailPage.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";

type Route =
  | { name: "runs" }
  | { name: "run"; id: string }
  | { name: "tasks" };

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "tasks") {
    return { name: "tasks" };
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
        </nav>
      </header>
      {route.name === "runs" && <RunsPage />}
      {route.name === "run" && <RunDetailPage id={route.id} />}
      {route.name === "tasks" && <TasksPage />}
    </div>
  );
}
