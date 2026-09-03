# Driving Flow Control through the adapter

[Flow Control](https://flow.ahorsburgh.com) is a human-supervised tower control demo. A person is the Supervising Controller at the browser window; the agent is the Tower Agent working through WebMCP. These notes are for an agent that has the adapter registered as an MCP server and is about to run a Shift.

## Before you start

Before a Shift is armed the page registers one tool, `describe_tower`. Call it: it tells you what the application is, the pending configuration, and that a person must click "Arm configured Shift" in the window. Ask them to. Arming revokes `describe_tower` and registers `begin_tower_shift`; re-list tools (or watch for the list change) rather than assuming.

## The loop

1. `begin_tower_shift` with `expectedStateVersion: 0`. Your tool list grows to nine.
2. `get_tower_snapshot`. Prefer `sections` or a lower `detail` over the full snapshot; the full one is large and most ticks only need traffic and transmissions. The snapshot carries `stateVersion` and `eventCursor`.
3. Loop: `wait_for_tower_event` with the last `cursor` and `heartbeatAfterMs: 1000`, act on what comes back, wait again. Quiet traffic means wait again, not stop. The simulation runs in real time while you think, so keep steps short.

Every mutation needs `expectedStateVersion` equal to the current `stateVersion`. A `stale` status means read a snapshot and retry.

## What the tools do

- `issue_runway_clearance`: `{ aircraftId, clearance: { kind, runwayId, runwayEnd }, expectedStateVersion }`. Kinds: `hold-short`, `line-up-and-wait`, `cancel-runway-clearance`, `clear-for-takeoff`, `clear-to-land`, `clear-touch-and-go`, `go-around`.
- `issue_tactical_instruction`: heading, altitude, speed, hold, orbit for one aircraft.
- `stage_recovery_plan`: two or more clearances during an emergency or after a rejected takeoff. Returns `approval-required`; the person approves in the window. Plans expire after 30 s of simulation time, so tell them straight away, and re-stage from current state if it lapses. Do not issue clearances while a plan is awaiting approval; that invalidates it.
- `evaluate_clearance_set`: check a set before acting.
- Read tools: `get_selected_context`, `get_active_conflicts`.

## The airfield

Runway 09-27 and crossing runway 04-22 share one intersection. Departures: FLOW 101 on 09, FLOW 404 on 27. Arrivals: FLOW 202 on 04, FLOW 303 on 22, FLOW 505 on 27. FLOW 106 and 108 fly the circuit on 09. Arrivals go around by themselves if they reach short final without a landing clearance or with the runway occupied, and a go-around drops their clearance, so re-clear them.

## What will happen

React to transmissions and events rather than assuming timings.

- An emergency: a MAYDAY and an `emergency-declared` event. Protect it first (priority landing; send any conflicting arrival around, which needs no approval), then stage a Recovery Plan.
- A pilot answers a landing clearance with "unable". Re-clear a little later.
- A rejected takeoff: the departure stops on the runway, which stays occupied for over a minute. Re-clearing it needs an approved Recovery Plan; a direct re-clearance returns `approval-required`.
- One arrival goes around on its own. Re-clear it.
- The Shift ends on `stable-flow-restored`. After that, waits return `monitoring-unavailable`, the snapshot shows `shiftStatus: "completed"`, and your tool list shrinks to five read-only tools.

Narrate each decision to the person in one line. They are watching the radar.
