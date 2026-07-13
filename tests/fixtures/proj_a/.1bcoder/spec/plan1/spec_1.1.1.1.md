# PLAN1-1.1.1.1: Request Body Specification

WHO: backend engineer
WHAT: validate and persist the incoming alert payload

DESCRIPTION:
Parses `alert_type` and `location` from the request body.

ACCEPTANCE CRITERIA:
- <valid payload stored, 201 returned>
- <missing field, 400 returned>

BOUNDARIES:
- <does not cover authentication>

SOURCE: [src: item_1.1.1.md#1]
