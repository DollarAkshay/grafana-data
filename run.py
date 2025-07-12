# A script to simplify redeployment and log viewing using Docker Compose
import subprocess
import sys

action = sys.argv[1] if len(sys.argv) > 1 else None

if not action:
    try:
        subprocess.run(["git", "pull"])
        subprocess.run(["docker", "compose", "up", "-d", "--force-recreate", "--no-deps", "--build"])
        print("\nService is running. Use 'python run.py logs' to view logs.\n")
        sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception as e:
        print(e)
        sys.exit(1)

if action == "logs":
    try:
        # Show logs (follow, last 30s)
        subprocess.run(["docker", "compose", "logs", "-f", "--since", "30s"])
        sys.exit(0)
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception as e:
        print(e)
        sys.exit(1)

if action == "help":
    print("\nUsage: python run.py [logs|help]\n")
    print("  (no argument) : Redeploy and show logs")
    print("  logs          : Show logs only")
    print("  help          : Show this help message\n")
    sys.exit(0)

print("Unknown command. Usage: python run.py [logs|help]")
sys.exit(1)
