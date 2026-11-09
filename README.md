# Mail to Calendar — Automator Service

## Overview

This Automator service extracts calendar events from the most recent email of the currently selected email thread in Apple Mail using an LLM (local Ollama or OpenAI), generates an .ics draft, and opens it in Calendar so you can choose the calendar and finalize the event.

## Key features

- Extracts event fields: title, start, end, timezone, location, notes, attendees, confidence.
- Accepts LLM responses that are a single JSON object or an array of events.
- Recovers when a model wraps the JSON in code fences, reasoning tags, or extra explanatory text, as long as a complete JSON object or array is present in the response.
- Automatically defaults end time when missing (configurable duration).
- Generates a temporary `.ics` file and shows a readable preview dialog with buttons: OK / Edit / Cancel.
  - OK: opens the .ics in Calendar (you choose the calendar and confirm creation).
  - Edit: opens the .ics in your default text editor; the workflow watches for a save, then opens the updated .ics in Calendar.
  - Cancel: aborts; when the provider was `mlx` or `ollama`, Cancel offers a secondary retry dialog to re-run with OpenAI.
- Offers an OpenAI retry when the local model is unavailable or returns invalid calendar data.
- Logs inputs, prompts, LLM output and errors to `~/Library/Logs/MailToCalendar.log` for debugging.
- Reads OpenAI API key from macOS Keychain by default (service `openai-API-token`, account = current `$USER`).

## Installation

1. Place the workflow file
   - Copy `Mail to Calendar.workflow` into `~/Library/Services/` (that path is already used for Services).
2. Give permissions
   - The first run will request Automation/access permissions for Mail (and Calendar if used). Approve those prompts.
   - If you run into permission issues, open System Settings → Privacy & Security → Automation / Full Disk Access and grant as needed for Automator / Mail / Calendar.
3. (Optional) Configure the provider and other settings
   - Open the workflow in Automator or `Contents/document.wflow` in a text editor, and edit the JavaScript action (the `document.wflow` Run JavaScript source).
   - In `CONFIG` you can change:
     - `provider`: **"mlx"** (default), or set to "ollama" or "openai" if you prefer a different backend. The workflow now assumes a local MLX-compatible model server by default.
     - `defaultDurationMinutes`: fallback duration when `end` is missing
     - `calendarName`: default calendar name (used only in older flows; the current .ics flow lets you choose)
     - `ollamaUrl` / `ollamaModel`: endpoint/model when provider is "ollama" (default gpt-oss:latest)
     - `mlxUrl` / `mlxModel`: endpoint/model for MLX (default `http://localhost:32000/v1/chat/completions`)
     - `mlxMaxTokens`: initial combined reasoning and answer budget (default 4096)
     - `mlxRetryMaxTokens`: budget for one automatic local retry after truncation (default 8192)
     - `mlxReasoningEffort`: reasoning effort passed via MLX `chat_template_kwargs` (default `low` for gpt-oss)
     - `openaiModel`: model when provider is "openai" (default gpt-5-mini)
     - `openaiApiKey`: set directly (string) or leave empty to read from Keychain
     - `openaiKeychainService` / `openaiKeychainAccount`: if you want a different Keychain entry
4. (If using OpenAI) Store your API key in Keychain (recommended)

   Example (Terminal):

   /usr/bin/security add-generic-password -s openai-API-token -a "$USER" -w "YOUR_OPENAI_KEY"

   Replace `YOUR_OPENAI_KEY` with your key. The workflow will read it by service name `openai-API-token` and account = current `USER`.

## Usage / Testing

- In Mail, select a message (or open a message and ensure it is focused), then choose the service from the Services menu or right-click → Services → Mail to Calendar.
- A preview dialog will appear showing extracted events. Choose:
  - `OK` → opens the `.ics` in Calendar.
  - `Edit` → opens the `.ics` in a text editor; after you save, Calendar will open the updated `.ics`.
  - `Cancel` → aborts; if the initial provider was `mlx` or `ollama`, you will be offered a retry with OpenAI.
- Check logs for debugging: `~/Library/Logs/MailToCalendar.log` — entries include the email text, prompt sent to the LLM, the raw LLM output, and any error stacks.

## Notes & Troubleshooting

- Timezone detection
  - The workflow uses macOS `NSTimeZone.systemTimeZone.name` to detect the IANA timezone (e.g. `Europe/Brussels`) and uses that in the prompt.
- Calendar write errors
  - Some calendars (subscribed or read-only) reject scripted event creation; the workflow avoids this by producing an `.ics` for you to import manually via Calendar.
- Local model connection failures
  - MLX must be running at the configured `mlxUrl` (by default `http://localhost:32000/v1/chat/completions`). A disabled startup agent or stopped server causes a connection failure.
  - The service shows the connection error and offers **Retry with ChatGPT**, which sends the selected email to OpenAI using your configured model and Keychain API key. MLX remains the default for the next run.
  - Requests have a 10-second connection timeout and a 180-second total timeout, extended to 360 seconds for the larger MLX retry. Logs include the actual error message, stack, and HTTP status instead of only JXA function names.
- LLM responses
  - The workflow asks for a single JSON object for one event, or a JSON array when the email clearly contains multiple separate events.
  - For reasoning models such as gpt-oss, `max_tokens` includes reasoning as well as the final JSON. MLX starts with a 4096-token budget and low reasoning effort. If the server reports `finish_reason: "length"`, the service automatically retries the same prompt once locally with 8192 tokens. If that retry also fails, the service reports the error and offers the OpenAI retry. Each new analysis starts at 4096 tokens.
  - HTTP log entries retain the requested model and token budget, plus `debug_finish_reason` and `debug_usage` separately from the length-limited raw response.
  - The parser will strip common wrapper text before decoding JSON. If parsing still fails, the raw LLM output is saved to the log for inspection.
- Editing the workflow
  - Edit `Contents/document.wflow` using Automator or a text editor to modify behavior. Be careful to keep XML-sensitive characters escaped when editing the embedded JavaScript source.

## Advanced

- To force OpenAI without Keychain, set `openaiApiKey` in `CONFIG` to your key (not recommended for security).
- To change the temporary `.ics` directory or filename, modify `tempIcsPath()` in the script.

## Regression checks

On macOS with Node.js installed, run `node --test tests/workflow.test.cjs`. The checks load the JavaScript directly from the installed workflow and cover HTTP errors, connection failures, OpenAI retry/decline behavior, generation limits, reasoning settings, and calendar draft generation using synthetic data.
