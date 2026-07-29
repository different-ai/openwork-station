import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { StationSurface } from "./station-surface.js"
import "./station.css"

// Surface entrypoint.
//
// This runs in a sandboxed renderer with no Node, no `require`, and no network
// beyond the hosts the user granted. The only host capability reachable from
// here is `window.openwork`, which the preload bridge froze to two functions.

const container = document.getElementById("station-root")
if (container) {
  createRoot(container).render(
    <StrictMode>
      <StationSurface />
    </StrictMode>,
  )
}
