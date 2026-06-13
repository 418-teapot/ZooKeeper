#!/usr/bin/env bash
#
# check-commit-msg.sh — Validate commit messages against the 5-part format
#
# Usage: bash check-commit-msg.sh [options] [file]
#   If file is provided, read from file. Otherwise read from stdin.
#   Options:
#     -m <message>   Validate the given message string directly
#   Note: When both -m and a file argument are given, -m takes priority.
# Exit code: 0 = valid, 1 = invalid
# Stdout: JSON {"status":"pass"|"fail","errors":[...]}
# Stderr: Human-readable color output

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# No temp file cleanup needed — -m messages are piped via stdin

ERRORS=()
VALID_TYPES=(feat fix perf security refactor test docs chore hotfix revert release deps migration style ci build wip)
SECTION_NAMES=(CONTEXT CHANGE WHY IMPACT)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

add_error() {
  local msg="$1"
  ERRORS+=("$msg")
  echo -e "${RED}✗ ${msg}${NC}" >&2
}

# Count words in a string (handles punctuation, hyphens, etc.)
word_count() {
  local str="$1"
  if [ -z "$str" ]; then
    echo 0
    return
  fi
  # Use printf to avoid issues with echo flags
  printf "%s" "$str" | wc -w | tr -d '[:space:]'
}

# Extract text content from a line: strip section label, leading spaces, bullet marker
extract_text() {
  local line="$1"
  # Remove section label prefix (e.g. "CONTEXT:  ")
  # We try all four; only one will match
  if [[ "$line" == CONTEXT:* ]]; then
    line="${line#CONTEXT: }"
  elif [[ "$line" == CHANGE:* ]]; then
    line="${line#CHANGE: }"
  elif [[ "$line" == WHY:* ]]; then
    line="${line#WHY: }"
  elif [[ "$line" == IMPACT:* ]]; then
    line="${line#IMPACT: }"
  fi
  # Strip leading whitespace using sed (portable)
  line=$(printf "%s" "$line" | sed 's/^[[:space:]]*//')
  # Remove "- " bullet marker if present
  if [[ "$line" == "- "* ]]; then
    line="${line#- }"
  fi
  # Strip leading/trailing whitespace again
  line=$(printf "%s" "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  echo "$line"
}

# Find the 0-indexed column of the first "- " in a line
get_dash_position() {
  local line="$1"
  local rest="${line#*- }"
  local pos=$(( ${#line} - ${#rest} - 2 ))
  echo "$pos"
}

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
MSG_STRING=""
FILE_ARG=""
M_FLAG=false

while [ $# -gt 0 ]; do
  case "$1" in
    -m)
      if [ $# -lt 2 ]; then
        echo '{"status":"fail","errors":["missing message after -m"]}'
        echo -e "${RED}✗ missing message after -m${NC}" >&2
        exit 1
      fi
      MSG_STRING="$2"
      shift 2
      M_FLAG=true
      ;;
    *)
      if [ -z "$FILE_ARG" ]; then
        FILE_ARG="$1"
      fi
      shift
      ;;
  esac
done

if [ "$M_FLAG" = true ] && [ -n "$FILE_ARG" ]; then
  echo -e "${YELLOW}⚠ Both -m and file argument provided; -m takes priority${NC}" >&2
fi

if [ "$M_FLAG" = true ]; then
  if [ -z "$MSG_STRING" ]; then
    echo '{"status":"fail","errors":["message is empty"]}'
    echo -e "${RED}✗ message is empty${NC}" >&2
    exit 1
  fi
  # Pipe the message as stdin so the existing stdin-reading branch handles it
  exec 0<<<"$MSG_STRING"
fi

# ---------------------------------------------------------------------------
# Read input
# ---------------------------------------------------------------------------
LINES=()
if [ -n "$FILE_ARG" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    LINES+=("$line")
  done < "$FILE_ARG"
else
  while IFS= read -r line || [ -n "$line" ]; do
    LINES+=("$line")
  done
fi

TOTAL_LINES=${#LINES[@]}

if [ "$TOTAL_LINES" -eq 0 ]; then
  add_error "line 1: commit message is empty"
  echo -e "${RED}✗ Commit message is empty.${NC}" >&2
  echo '{"status":"fail","errors":["line 1: commit message is empty"]}'
  exit 1
fi

echo -e "${YELLOW}Smart Git Commit — 提交消息检查${NC}" >&2
echo "" >&2

# ---------------------------------------------------------------------------
# CHECK 1: Summary line
# ---------------------------------------------------------------------------
SUMMARY="${LINES[0]}"
SUMMARY_LEN=${#SUMMARY}

# 1a. Summary not empty
if [ "$SUMMARY_LEN" -eq 0 ]; then
  add_error "line 1: summary line is empty"
fi

# 1b. Summary ≤ 72 chars
if [ "$SUMMARY_LEN" -gt 72 ]; then
  add_error "line 1: summary line is ${SUMMARY_LEN} characters (max 72) — shorten wording"
fi

# 1c. No trailing period on summary
if [ "$SUMMARY_LEN" -gt 0 ] && [ "${SUMMARY: -1}" = "." ]; then
  add_error "line 1: summary line must not end with a period"
fi

# 1d. Match type(scope)!: description pattern
# Pattern: ^[a-z]+(\([^)]+\))(!)?: .+$
# Use a variable for the regex to avoid bash parsing issues with complex patterns
SUMMARY_RE='^([a-z]+)(\([^)]+\))(!)?: (.+)$'
if [[ "$SUMMARY" =~ $SUMMARY_RE ]]; then
  TYPE="${BASH_REMATCH[1]}"
  SCOPE_PART="${BASH_REMATCH[2]}"
  BREAKING_PART="${BASH_REMATCH[3]}"
  DESC="${BASH_REMATCH[4]}"

  # Validate type
  TYPE_VALID=false
  for vt in "${VALID_TYPES[@]}"; do
    if [ "$TYPE" = "$vt" ]; then
      TYPE_VALID=true
      break
    fi
  done
  if [ "$TYPE_VALID" = false ]; then
    add_error "line 1: invalid type '${TYPE}' (valid: ${VALID_TYPES[*]})"
  fi

  # Description should not be empty
  if [ -z "$DESC" ]; then
    add_error "line 1: summary line missing description after 'type: '"
  fi
else
  add_error "line 1: summary line does not match pattern 'type(scope): description'"
fi

# ---------------------------------------------------------------------------
# CHECK 2: Body structure
# ---------------------------------------------------------------------------

# 2a. Line 2 must be blank if body exists
if [ "$TOTAL_LINES" -gt 1 ] && [ -n "${LINES[1]:-}" ]; then
  add_error "line 2: expected blank line after summary"
fi

# 2b. Find section label indices (search from line 3 onward, 0-indexed index 2)
CONTEXT_IDX=-1
CHANGE_IDX=-1
WHY_IDX=-1
IMPACT_IDX=-1

# Use variable-based regex to avoid bash parsing issues with nested bracket expressions
# Require at least one non-whitespace character after "- " (empty bullets not allowed)
CONTEXT_RE='^CONTEXT:[[:space:]]+-[[:space:]]+[^[:space:]].*$'
CHANGE_RE='^CHANGE:[[:space:]]+-[[:space:]]+[^[:space:]].*$'
WHY_RE='^WHY:[[:space:]]+-[[:space:]]+[^[:space:]].*$'
IMPACT_RE='^IMPACT:[[:space:]]+-[[:space:]]+[^[:space:]].*$'

for (( i = 2; i < TOTAL_LINES; i++ )); do
  line="${LINES[$i]}"
  # Match: ^SECTION: +- .+$  (label, colon, one+ spaces, "- ", non-empty text)
  if [[ "$line" =~ $CONTEXT_RE ]] && [ "$CONTEXT_IDX" -eq -1 ]; then
    CONTEXT_IDX=$i
  elif [[ "$line" =~ $CHANGE_RE ]] && [ "$CHANGE_IDX" -eq -1 ]; then
    CHANGE_IDX=$i
  elif [[ "$line" =~ $WHY_RE ]] && [ "$WHY_IDX" -eq -1 ]; then
    WHY_IDX=$i
  elif [[ "$line" =~ $IMPACT_RE ]] && [ "$IMPACT_IDX" -eq -1 ]; then
    IMPACT_IDX=$i
  fi
done

# Check presence of each section
if [ "$CONTEXT_IDX" -eq -1 ]; then
  add_error "line 2+: missing CONTEXT section"
fi
if [ "$CHANGE_IDX" -eq -1 ]; then
  add_error "line 2+: missing CHANGE section"
fi
if [ "$WHY_IDX" -eq -1 ]; then
  add_error "line 2+: missing WHY section"
fi
if [ "$IMPACT_IDX" -eq -1 ]; then
  add_error "line 2+: missing IMPACT section"
fi

# Check ordering and section gaps (only if all sections found)
if [ "$CONTEXT_IDX" -ne -1 ] && [ "$CHANGE_IDX" -ne -1 ] && [ "$WHY_IDX" -ne -1 ] && [ "$IMPACT_IDX" -ne -1 ]; then

  # Ordering checks
  if [ "$CONTEXT_IDX" -ge "$CHANGE_IDX" ]; then
    add_error "line $((CONTEXT_IDX+1)): CONTEXT section must appear before CHANGE section"
  fi
  if [ "$CHANGE_IDX" -ge "$WHY_IDX" ]; then
    add_error "line $((CHANGE_IDX+1)): CHANGE section must appear before WHY section"
  fi
  if [ "$WHY_IDX" -ge "$IMPACT_IDX" ]; then
    add_error "line $((WHY_IDX+1)): WHY section must appear before IMPACT section"
  fi

  # Helper: check gap between two sections
  check_section_gap() {
    local label_idx=$1
    local next_idx=$2
    local name=$3

    if [ "$next_idx" -le "$label_idx" ]; then
      return
    fi

    local gap_start=$((label_idx + 1))
    local gap_end=$((next_idx - 1))

    if [ "$gap_start" -gt "$gap_end" ]; then
      # Sections adjacent — no room for a blank line
      add_error "line $((next_idx+1)): expected 1 blank line after ${name} section, found 0"
      return
    fi

    local found_blank=false
    local blank_count=0

    for (( i = gap_start; i <= gap_end; i++ )); do
      if [ -z "${LINES[$i]:-}" ]; then
        found_blank=true
        blank_count=$((blank_count + 1))
      else
        if [ "$found_blank" = true ]; then
          add_error "line $((i+1)): unexpected content after blank line in ${name} section gap"
        fi
      fi
    done

    if [ "$blank_count" -eq 0 ]; then
      add_error "line $((next_idx+1)): expected 1 blank line after ${name} section, found 0"
    elif [ "$blank_count" -gt 1 ]; then
      add_error "line $((next_idx+1)): expected 1 blank line after ${name} section, found ${blank_count}"
    fi
  }

  check_section_gap "$CONTEXT_IDX" "$CHANGE_IDX" "CONTEXT"
  check_section_gap "$CHANGE_IDX" "$WHY_IDX" "CHANGE"
  check_section_gap "$WHY_IDX" "$IMPACT_IDX" "WHY"
fi

# ---------------------------------------------------------------------------
# CHECK 3: Line length (skip blank lines)
# ---------------------------------------------------------------------------
for (( i = 0; i < TOTAL_LINES; i++ )); do
  line="${LINES[$i]}"
  if [ -n "$line" ] && [ ${#line} -gt 72 ]; then
    add_error "line $((i+1)): ${#line} characters (max 72) — rewrap or shorten wording"
  fi
done

# ---------------------------------------------------------------------------
# CHECK 4: Bullet format
# ---------------------------------------------------------------------------

# Collect bullet group info for checks 4 and 6
# We process each section: iterate from section label to the next section (or end)
# For each bullet group (starts with a "- " line, followed by continuation lines),
# check that the last line of the group ends with "."

# Regex for continuation line detection (starts with whitespace, no "- " marker)
CONTINUATION_RE='^[[:space:]]+[^[:space:]-]'

process_section_bullets() {
  local start_idx=$1
  local end_idx=$2   # exclusive (the line index after the last content line)

  if [ "$start_idx" -lt 0 ]; then
    return
  fi

  # If end_idx not specified, use TOTAL_LINES
  if [ "$end_idx" -le "$start_idx" ]; then
    end_idx=$TOTAL_LINES
  fi

  local i=$start_idx
  while [ "$i" -lt "$end_idx" ]; do
    local line="${LINES[$i]:-}"

    # Skip blank lines
    if [ -z "$line" ]; then
      i=$((i + 1))
      continue
    fi

    # Check if this line has a "- " marker (i.e., is a bullet start)
    if [[ "$line" == *"- "* ]]; then
      # Find the end of this bullet group
      local group_start=$i
      local group_end=$i

      i=$((i + 1))
      while [ "$i" -lt "$end_idx" ]; do
        local next="${LINES[$i]:-}"
        if [ -z "$next" ]; then
          break  # blank line ends the group
        fi
        # If next line has "- ", it's a new bullet
        if [[ "$next" == *"- "* ]]; then
          break
        fi
        # Otherwise it's a continuation line
        group_end=$i
        i=$((i + 1))
      done

      # Check that the last line of this group ends with "."
      local last_line="${LINES[$group_end]}"
      # Trim trailing whitespace using sed (portable)
      local trimmed
      trimmed=$(printf "%s" "$last_line" | sed 's/[[:space:]]*$//')
      if [ "${trimmed: -1}" != "." ]; then
        add_error "line $((group_end+1)): bullet text must end with a period"
      fi

      # Continue from where we left off (i already advanced past the group)
      continue
    elif [[ "$line" =~ $CONTINUATION_RE ]]; then
      # Continuation line without "- " — belongs to previous group (already processed)
      i=$((i + 1))
      continue
    fi

    i=$((i + 1))
  done
}

# Process each section's bullet groups
# We need the section boundaries
if [ "$CONTEXT_IDX" -ne -1 ] && [ "$CHANGE_IDX" -ne -1 ]; then
  process_section_bullets "$CONTEXT_IDX" "$CHANGE_IDX"
fi
if [ "$CHANGE_IDX" -ne -1 ] && [ "$WHY_IDX" -ne -1 ]; then
  process_section_bullets "$CHANGE_IDX" "$WHY_IDX"
fi
if [ "$WHY_IDX" -ne -1 ] && [ "$IMPACT_IDX" -ne -1 ]; then
  process_section_bullets "$WHY_IDX" "$IMPACT_IDX"
fi
if [ "$IMPACT_IDX" -ne -1 ]; then
  # IMPACT goes to end, but stop at first blank line (footers separator)
  impact_end=$IMPACT_IDX
  for (( i = IMPACT_IDX + 1; i < TOTAL_LINES; i++ )); do
    if [ -z "${LINES[$i]:-}" ]; then
      impact_end=$i
      break
    fi
  done
  if [ "$impact_end" -eq "$IMPACT_IDX" ]; then
    impact_end=$TOTAL_LINES
  fi
  process_section_bullets "$IMPACT_IDX" "$impact_end"
fi

# ---------------------------------------------------------------------------
# CHECK 5: Word limits
# ---------------------------------------------------------------------------

# Collect words per section
count_section_words() {
  local start_idx=$1
  local end_idx=$2   # exclusive
  local total=0

  if [ "$start_idx" -lt 0 ]; then
    echo 0
    return
  fi
  if [ "$end_idx" -le "$start_idx" ]; then
    echo 0
    return
  fi

  local words=""
  for (( i = start_idx; i < end_idx; i++ )); do
    local line="${LINES[$i]:-}"
    if [ -z "$line" ]; then
      continue
    fi
    local txt
    txt=$(extract_text "$line")
    if [ -n "$txt" ]; then
      if [ -n "$words" ]; then
        words="$words $txt"
      else
        words="$txt"
      fi
    fi
  done

  word_count "$words"
}

# Helper: get section end index (exclusive) given the next section label index
get_section_end() {
  local start_idx=$1
  local next_idx=$2

  if [ "$start_idx" -lt 0 ]; then
    echo -1
    return
  fi

  if [ "$next_idx" -le "$start_idx" ]; then
    # Find first blank line after start_idx
    for (( i = start_idx + 1; i < TOTAL_LINES; i++ )); do
      if [ -z "${LINES[$i]:-}" ]; then
        echo "$i"
        return
      fi
    done
    echo "$TOTAL_LINES"
    return
  fi

  # Content ends at the last non-blank line before next_idx
  local end=$start_idx
  for (( i = start_idx + 1; i < next_idx; i++ )); do
    if [ -n "${LINES[$i]:-}" ]; then
      end=$i
    fi
  done
  echo $((end + 1))
}

CTX_WORDS=0
CHG_WORDS=0
WHY_WORDS=0
IMP_WORDS=0

if [ "$CONTEXT_IDX" -ne -1 ] && [ "$CHANGE_IDX" -ne -1 ]; then
  CTX_END=$(get_section_end "$CONTEXT_IDX" "$CHANGE_IDX")
  CTX_WORDS=$(count_section_words "$CONTEXT_IDX" "$CTX_END")
fi

if [ "$CHANGE_IDX" -ne -1 ] && [ "$WHY_IDX" -ne -1 ]; then
  CHG_END=$(get_section_end "$CHANGE_IDX" "$WHY_IDX")
  CHG_WORDS=$(count_section_words "$CHANGE_IDX" "$CHG_END")
fi

if [ "$WHY_IDX" -ne -1 ] && [ "$IMPACT_IDX" -ne -1 ]; then
  WHY_END=$(get_section_end "$WHY_IDX" "$IMPACT_IDX")
  WHY_WORDS=$(count_section_words "$WHY_IDX" "$WHY_END")
fi

if [ "$IMPACT_IDX" -ne -1 ]; then
  IMP_END=$(get_section_end "$IMPACT_IDX" "-1")
  IMP_WORDS=$(count_section_words "$IMPACT_IDX" "$IMP_END")
fi

if [ "$CTX_WORDS" -gt 40 ]; then
  add_error "line $((CONTEXT_IDX+1)): CONTEXT section has ${CTX_WORDS} words (max 40)"
fi
if [ "$CHG_WORDS" -gt 70 ]; then
  add_error "line $((CHANGE_IDX+1)): CHANGE section has ${CHG_WORDS} words (max 70)"
fi
if [ "$WHY_WORDS" -gt 70 ]; then
  add_error "line $((WHY_IDX+1)): WHY section has ${WHY_WORDS} words (max 70)"
fi
if [ "$IMP_WORDS" -gt 30 ]; then
  add_error "line $((IMPACT_IDX+1)): IMPACT section has ${IMP_WORDS} words (max 30)"
fi

TOTAL_BODY_WORDS=$((CTX_WORDS + CHG_WORDS + WHY_WORDS + IMP_WORDS))
if [ "$TOTAL_BODY_WORDS" -gt 200 ]; then
  add_error "line 2+: body has ${TOTAL_BODY_WORDS} words total (max 200)"
fi

# ---------------------------------------------------------------------------
# CHECK 6: Padding alignment (bullet "- " column consistency)
# ---------------------------------------------------------------------------

BULLET_POSITIONS=()

collect_bullet_positions() {
  local start_idx=$1
  local end_idx=$2

  if [ "$start_idx" -lt 0 ]; then
    return
  fi
  if [ "$end_idx" -le "$start_idx" ]; then
    return
  fi

  for (( i = start_idx; i < end_idx; i++ )); do
    local line="${LINES[$i]:-}"
    if [ -z "$line" ]; then
      continue
    fi
    # Check if line contains "- "
    if [[ "$line" == *"- "* ]]; then
      local pos
      pos=$(get_dash_position "$line")
      BULLET_POSITIONS+=("$pos")
    fi
  done
}

# Collect from all sections
if [ "$CONTEXT_IDX" -ne -1 ] && [ "$CHANGE_IDX" -ne -1 ]; then
  collect_bullet_positions "$CONTEXT_IDX" "$CHANGE_IDX"
fi
if [ "$CHANGE_IDX" -ne -1 ] && [ "$WHY_IDX" -ne -1 ]; then
  collect_bullet_positions "$CHANGE_IDX" "$WHY_IDX"
fi
if [ "$WHY_IDX" -ne -1 ] && [ "$IMPACT_IDX" -ne -1 ]; then
  collect_bullet_positions "$WHY_IDX" "$IMPACT_IDX"
fi
if [ "$IMPACT_IDX" -ne -1 ]; then
  impact_end=$IMPACT_IDX
  for (( i = IMPACT_IDX + 1; i < TOTAL_LINES; i++ )); do
    if [ -z "${LINES[$i]:-}" ]; then
      break
    fi
    impact_end=$i
  done
  impact_end=$((impact_end + 1))
  collect_bullet_positions "$IMPACT_IDX" "$impact_end"
fi

if [ ${#BULLET_POSITIONS[@]} -gt 0 ]; then
  # Find mode position
  # Use simple counting (compatible with bash 3.x)
  POS_VALUES=()
  POS_COUNTS=()

  for pos in "${BULLET_POSITIONS[@]}"; do
    found_index=-1
    for (( j = 0; j < ${#POS_VALUES[@]}; j++ )); do
      if [ "${POS_VALUES[$j]}" -eq "$pos" ]; then
        found_index=$j
        break
      fi
    done
    if [ "$found_index" -ge 0 ]; then
      POS_COUNTS[$found_index]=$((POS_COUNTS[$found_index] + 1))
    else
      POS_VALUES+=("$pos")
      POS_COUNTS+=(1)
    fi
  done

  # Find max count
  MODE="${POS_VALUES[0]}"
  MAX_COUNT="${POS_COUNTS[0]}"
  for (( j = 1; j < ${#POS_VALUES[@]}; j++ )); do
    if [ "${POS_COUNTS[$j]}" -gt "$MAX_COUNT" ]; then
      MAX_COUNT="${POS_COUNTS[$j]}"
      MODE="${POS_VALUES[$j]}"
    fi
  done

  # Check each bullet position
  line_num=0
  for (( i = 2; i < TOTAL_LINES; i++ )); do
    line="${LINES[$i]:-}"
    if [ -z "$line" ]; then
      continue
    fi
    if [[ "$line" == *"- "* ]]; then
      pos=$(get_dash_position "$line")
      diff=$((pos - MODE))
      if [ "$diff" -lt 0 ]; then
        diff=$((-diff))
      fi
      if [ "$diff" -gt 1 ]; then
        add_error "line $((i+1)): bullet alignment column ${pos} differs from mode ${MODE} by more than 1"
      fi
    fi
  done
fi

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
if [ ${#ERRORS[@]} -eq 0 ]; then
  echo -e "${GREEN}✓ Commit message is valid.${NC}" >&2
  echo '{"status":"pass","errors":[]}'
  exit 0
else
  echo -e "${RED}✗ Commit message has ${#ERRORS[@]} error(s).${NC}" >&2
  # Build JSON errors array
  JSON_ERRORS="["
  first=true
  for err in "${ERRORS[@]}"; do
    if [ "$first" = true ]; then
      first=false
    else
      JSON_ERRORS+=","
    fi
    # Escape double quotes and backslashes
    escaped=$(printf "%s" "$err" | sed 's/"/\\"/g; s/\\/\\\\/g')
    JSON_ERRORS+="\"${escaped}\""
  done
  JSON_ERRORS+="]"
  echo "{\"status\":\"fail\",\"errors\":${JSON_ERRORS}}"
  exit 1
fi
