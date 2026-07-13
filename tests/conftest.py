import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
PROJ_A = os.path.join(FIXTURES, "proj_a")
PROJ_B = os.path.join(FIXTURES, "proj_b")
