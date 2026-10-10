import argparse, json, sys
from desktop_common import targets, entry
def main():
    argparse.ArgumentParser(description='List target types only; no websocket URLs, titles, bodies or session identifiers').parse_args()
    print(json.dumps({'types':[t.get('type') for t in targets()]}))
if __name__=='__main__': sys.exit(entry(main))
