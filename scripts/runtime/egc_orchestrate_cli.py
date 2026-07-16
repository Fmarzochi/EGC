import sys
import argparse
from scripts.orchestration.orchestrator import ORCHESTRATOR

def main():
    parser = argparse.ArgumentParser(description="EGC Live Orchestration CLI")
    parser.add_argument("task", help="The task to execute")
    parser.add_argument("--context", help="JSON context string", default="{}")
    
    args = parser.parse_args()
    
    try:
        import json
        context_data = json.loads(args.context)
    except json.JSONDecodeError:
        context_data = {}

    print("\n[EGC Orchestrator] Starting task...\n")
    orchestrator = ORCHESTRATOR()
    result = orchestrator.dispatch(args.task, context_data)

    if result["status"] == "success":
        print(f"\nPASS: SUCCESS: {result['agent']} completed the task.")
        print(f"Output: {result['output']}\n")
    else:
        print(f"\nFAIL: FAILURE: {result.get('error', 'Unknown error')}\n")

if __name__ == "__main__":
    main()
