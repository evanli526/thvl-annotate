#!/usr/bin/env python3
"""Run the THVL annotation app: python annotate.py."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent/'annotate'))
from desktop import main
if __name__=='__main__':main()
