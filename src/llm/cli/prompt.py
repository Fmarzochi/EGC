#!/usr/bin/env python3
import sys
import os
import asyncio
import argparse
import json
from llm.providers import get_provider
from llm.session_recorder import SessionRecorder
from llm.dispatcher import Dispatcher
from llm.tools import ToolExecutor, ToolRegistry
from llm.tools.executor import ReActAgent
from llm.core.types import LLMInput, Message, Role

def format_osc8(text: str, uri: str) -> str:
    """Format a string as an OSC-8 terminal hyperlink."""
    if os.environ.get("NO_COLOR") or os.environ.get("TERM") == "dumb":
        return f"{text} ({uri})"
    return f"\x1b]8;;{uri}\x1b\\{text}\x1b]8;;\x1b\\"


async def run_prompt(prompt: str, model: str = None):
    # 1. Setup Session & Persistence
    session_id = os.environ.get("EGC_SESSION_ID") or os.environ.get("ECC_SESSION_ID") or "default-session"
    recorder = SessionRecorder(session_id=session_id)
    recorder.record("session_start", {"prompt": prompt, "model": model})
    
    session_uri = f"egc://session/{session_id}"
    print(f"[Recorder] Session {format_osc8(session_id, session_uri)} active.")

    # 2. Setup Dispatcher (Hooks Mesh)
    dispatcher = Dispatcher(recorder=recorder)
    print(f"[Dispatcher] Active with mesh configuration.")

    # 3. Trigger SessionStart hook event and ingest context
    system_instruction_context = ""
    start_result = dispatcher.dispatch("SessionStart", session_id=session_id)
    if start_result.hook_outputs:
        additional_context = start_result.hook_outputs.get("additionalContext", "")
        if additional_context:
            print(f"[Dispatcher] Ingesting additional context ({len(additional_context)} chars).")
            system_instruction_context = f"\n\n--- PREVIOUS SESSION CONTEXT ---\n{additional_context}\n--- END CONTEXT ---\n"

    try:
        # 4. Initialize Provider
        provider = get_provider(model=model)

        # 5. Agent Setup
        registry = ToolRegistry()
        executor = ToolExecutor(registry=registry)
        agent = ReActAgent(provider=provider, executor=executor, recorder=recorder)
        # 6. Execute
        full_prompt = prompt
        if system_instruction_context:
            full_prompt = f"{system_instruction_context}\nUser Request: {prompt}"

        messages = [Message(role=Role.USER, content=full_prompt)]
        input_data = LLMInput(messages=messages, model=model, session_id=session_id)

        print(f"--- EGC Bridge Execution (Session: {session_id}) ---")
        output = agent.run(input_data)

        print(output.content)
    finally:
        # 7. Complete Lifecycle
        print(f"[Dispatcher] Completing session lifecycle...")
        extra = {"transcript_path": recorder.log_path}
        dispatcher.dispatch("Stop", session_id=session_id, extra_payload=extra)
        recorder.record("session_end", {"status": "completed"})
        dispatcher.dispatch("SessionEnd", session_id=session_id, extra_payload=extra)


def main():
    parser = argparse.ArgumentParser(description="EGC Minimal Bridge - Prompt Execution")
    parser.add_argument("-p", "--prompt", required=True, help="The prompt to execute")
    parser.add_argument("--model", help="LLM model to use")
    
    args = parser.parse_args()
    
    try:
        asyncio.run(run_prompt(args.prompt, args.model))
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
