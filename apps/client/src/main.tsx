/**
 * Entry point. Deliberately tiny: it checks the build-time environment first,
 * then loads the real app (./bootstrap) with a dynamic import. Anything that
 * goes wrong (missing variables, a module that throws while loading, a render
 * crash) ends on a visible screen instead of a blank page.
 */
import React from "react";
import ReactDOM from "react-dom/client";

import { missingEnvVars } from "@/lib/env-check";
import {
  CrashScreen,
  EnvMissingScreen,
} from "@/shared/ui/feedback/startup-screens";

const root = ReactDOM.createRoot(document.getElementById("root")!);

const missing = missingEnvVars({
  API_BASE_URL: import.meta.env.API_BASE_URL,
  STORE_URL: import.meta.env.STORE_URL,
});

if (missing.length > 0) {
  // eslint-disable-next-line no-console -- the screen tells users to check the console
  console.error(
    `Missing build-time environment variables: ${missing.join(", ")}`,
  );
  root.render(<EnvMissingScreen missing={missing} />);
} else {
  import("./bootstrap")
    .then(({ renderApp }) => renderApp(root))
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console -- see CrashScreen
      console.error("The app failed to load", error);
      root.render(
        <React.StrictMode>
          <CrashScreen error={error} />
        </React.StrictMode>,
      );
    });
}
