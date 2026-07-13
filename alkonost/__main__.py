"""alkonost CLI entry point — mirrors vyrii's own __main__.py pattern:
argparse -> flask_api.create_app() -> waitress.serve() (never app.run())."""
import argparse
import os

from .flask_api import create_app
from . import discovery


def main() -> None:
    parser = argparse.ArgumentParser(prog="alkonost", description=__doc__)
    parser.add_argument("-p", "--port", type=int, default=8090)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--root", default=os.getcwd(),
                         help="directory to scan for .1bcoder/ projects (default: cwd)")
    parser.add_argument("--max-depth", type=int, default=6,
                         help="max recursion depth when scanning for .1bcoder/ (default: 6)")
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    projects = discovery.discover_projects(root, args.max_depth)

    app = create_app(root=root, max_depth=args.max_depth)
    print(f"alkonost -> http://localhost:{args.port}  (UI: /ui/)")
    print(f"  root       : {root}")
    print(f"  max-depth  : {args.max_depth}")
    print(f"  projects   : {len(projects)} found")
    for info in sorted(projects.values(), key=lambda i: i['name']):
        print(f"    - {info['name']} ({info['plan_count']} plan(s)) — {info['root']}")

    from waitress import serve
    serve(app, host=args.bind, port=args.port, threads=8)


if __name__ == "__main__":
    main()
