#!/bin/bash
#
# COBOL Repository Scanner & Validator
# 
# This script scans a COBOL repository, identifies programs, attempts to execute them
# both natively (via cobc) and via Java conversion (via cobj), and compares the output.
#
# Usage:
#   ./cobol_repo_scanner.sh <git-url-or-path> [output-dir]
#

set -o pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
TOTAL_FILES=0
PROCESSED_FILES=0
SUCCESS_MATCH=0
SUCCESS_MISMATCH=0
FAIL_CONVERSION=0
FAIL_EXECUTION=0
SKIPPED_COPYBOOK=0
SKIPPED_NO_ID=0

# JSON Report items
JSON_ITEMS=()

# Cleanup function
cleanup() {
    if [[ -n "$TEMP_CLONE_DIR" && -d "$TEMP_CLONE_DIR" ]]; then
        echo -e "${BLUE}[INFO]${NC} Cleaning up temporary directory: $TEMP_CLONE_DIR"
        rm -rf "$TEMP_CLONE_DIR"
    fi
}

# Log function
log() {
    local level="$1"
    local message="$2"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
    case "$level" in
        INFO)  echo -e "${BLUE}[$timestamp] [INFO]${NC} $message" ;;
        OK)    echo -e "${GREEN}[$timestamp] [OK]${NC} $message" ;;
        MATCH) echo -e "${GREEN}[$timestamp] [MATCH]${NC} $message" ;;
        WARN)  echo -e "${YELLOW}[$timestamp] [WARN]${NC} $message" ;;
        ERROR) echo -e "${RED}[$timestamp] [ERROR]${NC} $message" ;;
        SKIP)  echo -e "${YELLOW}[$timestamp] [SKIP]${NC} $message" ;;
        FAIL)  echo -e "${RED}[$timestamp] [FAIL]${NC} $message" ;;
        MISMATCH) echo -e "${RED}[$timestamp] [MISMATCH]${NC} $message" ;;
    esac
    
    # Also write to log file
    echo "[$timestamp] [$level] $message" >> "$LOG_FILE"
}

# Check if a file is a standalone COBOL program
is_standalone_program() {
    local file="$1"
    if grep -qi "IDENTIFICATION[[:space:]]\+DIVISION" "$file" 2>/dev/null; then
        return 0
    fi
    return 1
}

# Check requirements
check_requirements() {
    if ! command -v cobj &> /dev/null; then
        echo -e "${RED}[ERROR]${NC} cobj compiler not found in PATH"
        exit 1
    fi
    if ! command -v cobc &> /dev/null; then
        log "WARN" "cobc (GnuCOBOL) not found. Native execution comparison will be skipped."
        HAS_COBC=false
    else
        HAS_COBC=true
    fi
    if ! command -v java &> /dev/null; then
         echo -e "${RED}[ERROR]${NC} java not found in PATH"
         exit 1
    fi
    if ! command -v javac &> /dev/null; then
         echo -e "${RED}[ERROR]${NC} javac not found in PATH"
         exit 1
    fi
}

# Clone or use path
clone_or_use_path() {
    local input="$1"
    if [[ "$input" =~ ^(https?://|git@|git://) ]] || [[ "$input" =~ \.git$ ]]; then
        log "INFO" "Detected Git URL, cloning repository..."
        # Clone into output dir to persist source for viewing
        local clone_dir="$OUTPUT_DIR/source"
        mkdir -p "$clone_dir"
        
        if git clone --depth 1 "$input" "$clone_dir" 2>&1; then
            log "OK" "Repository cloned to: $clone_dir"
            SOURCE_DIR="$clone_dir"
            # No cleanup trap needed as it's part of output
        else
            log "ERROR" "Failed to clone repository: $input"
            exit 1
        fi
    else
        if [[ ! -d "$input" ]]; then
            log "ERROR" "Directory not found: $input"
            exit 1
        fi
        SOURCE_DIR=$(realpath "$input")
        log "INFO" "Using local directory: $SOURCE_DIR"
    fi
}


# Setup dependency paths
setup_dependencies() {
    log "INFO" "Scanning for include paths (directories with .cpy files)..."
    INCLUDE_FLAGS=""
    # Find all directories in source that contain .cpy files
    while IFS= read -r -d '' dir; do
        # Check if dir contains any .cpy or .CPY files
        if ls "$dir"/*.cpy &>/dev/null || ls "$dir"/*.CPY &>/dev/null; then
            INCLUDE_FLAGS="$INCLUDE_FLAGS -I $dir"
        fi
    done < <(find "$SOURCE_DIR" -type d -print0)
    
    # Trim leading space
    INCLUDE_FLAGS=${INCLUDE_FLAGS# }
    
    # Count includes
    local count=$(echo "$INCLUDE_FLAGS" | grep -o "\-I" | wc -l)
    log "INFO" "Added $count include paths."
}


# Process a single file
process_file() {
    local file="$1"
    local relative_path="${file#$SOURCE_DIR/}"
    local filename=$(basename "$file")
    local extension="${filename##*.}"
    local basename="${filename%.*}"
    
    ((TOTAL_FILES++))
    
    # Check copybook
    if [[ "${extension,,}" == "cpy" ]]; then
        log "SKIP" "$relative_path - Copybook file (.cpy extension)"
        ((SKIPPED_COPYBOOK++))
        add_json_item "$relative_path" "$file" "SKIPPED_COPYBOOK" "" "" "N/A"
        return
    fi
    
    # Check ID DIVISION
    if ! is_standalone_program "$file"; then
        log "SKIP" "$relative_path - No IDENTIFICATION DIVISION found"
        ((SKIPPED_NO_ID++))
        add_json_item "$relative_path" "$file" "SKIPPED_NO_ID" "" "" "N/A"
        return
    fi
    
    ((PROCESSED_FILES++))
    log "INFO" "Processing: $relative_path"

    # Setup directories for this file
    local work_dir="$OUTPUT_DIR/work/${relative_path//\//_}"
    mkdir -p "$work_dir"
    mkdir -p "$work_dir/native"
    mkdir -p "$work_dir/java"
    
    local native_out="$work_dir/native_output.txt"
    local java_out="$work_dir/java_output.txt"
    local native_status="SKIPPED"
    local java_status="FAIL"
    local compare_status="N/A"

    # 1. Native Execution (if cobc available)
    if [[ "$HAS_COBC" == "true" ]]; then
        log "INFO" "  Compiling and running Native COBOL..."
        # Compile with timeout
        if timeout 10s cobc -x -o "$work_dir/native/app" "$file" $INCLUDE_FLAGS &> "$work_dir/native_compile.log"; then
             # Run (timeout 5s, kill after 1s)
             if timeout -k 1s 5s "$work_dir/native/app" > "$native_out" 2> "$work_dir/native_stderr.log"; then
                 native_status="SUCCESS"
                 # Combine stdout and stderr for comparison
                 cat "$work_dir/native_stderr.log" >> "$native_out"
             else
                 log "WARN" "  Native execution failed or timed out"
                 native_status="EXEC_FAIL"
                 echo "EXECUTION_FAILED" > "$native_out"
             fi
        else
             log "WARN" "  Native compilation failed"
             native_status="COMPILE_FAIL"
             echo "COMPILATION_FAILED" > "$native_out"
        fi
    fi

    # 2. Java Conversion & Execution
    log "INFO" "  Converting to Java..."
    local java_src_dir="$OUTPUT_DIR/java"
    mkdir -p "$java_src_dir"
    
    # cobj conversion with timeout
    if timeout 20s cobj -C -j "$java_src_dir" "$file" $INCLUDE_FLAGS &> "$work_dir/cobj.log"; then
        log "OK" "  Conversion successful"
        
        # Compile Java
        log "INFO" "  Compiling Java..."
        # ... (classpath logic) ...
        local CLASSPATH="."
        if [[ -f "/usr/lib/opensourcecobol4j/lib/libcobj.jar" ]]; then
             CLASSPATH="$CLASSPATH:/usr/lib/opensourcecobol4j/lib/libcobj.jar"
        elif [[ -f "/usr/local/lib/opensourcecobol4j/libcobj.jar" ]]; then
             CLASSPATH="$CLASSPATH:/usr/local/lib/opensourcecobol4j/libcobj.jar"
        else 
             local found_jar=$(find /usr -name libcobj.jar -print -quit 2>/dev/null)
             if [[ -n "$found_jar" ]]; then
                 CLASSPATH="$CLASSPATH:$found_jar"
             fi
        fi
        
        # Compile all generated java files
        if timeout 20s javac -cp "$CLASSPATH" "$java_src_dir"/*.java &>> "$work_dir/javac.log"; then
             # Run Java
             local prog_id=$(grep -i "PROGRAM-ID\." "$file" | sed -E 's/.*PROGRAM-ID\.[[:space:]]*([^.]+)\..*/\1/I' | tr -d ' ')
             
             if [[ -n "$prog_id" ]]; then
                  log "INFO" "  Running Java class: $prog_id"
                  if timeout -k 1s 5s java -cp "$CLASSPATH:$java_src_dir" "$prog_id" > "$java_out" 2> "$work_dir/java_stderr.log"; then
                      java_status="SUCCESS"
                      cat "$work_dir/java_stderr.log" >> "$java_out"
                  else
                      log "ERROR" "  Java execution failed"
                      java_status="EXEC_FAIL"
                      echo "EXECUTION_FAILED" > "$java_out"
                      ((FAIL_EXECUTION++))
                  fi
             else
                  log "ERROR" "  Could not determine PROGRAM-ID"
                  java_status="UNKNOWN_ID"
             fi
        else
             log "ERROR" "  Java compilation failed. Check $work_dir/javac.log"
             java_status="COMPILE_FAIL"
             ((FAIL_COMPILE++))
        fi
    else
        # Read the error log to show meaningful message
        local error_msg=$(head -n 1 "$work_dir/cobj.log")
        log "ERROR" "  Conversion failed: $error_msg"
        java_status="CONVERT_FAIL"
        ((FAIL_CONVERSION++))
    fi

    # 3. Compare
    if [[ "$native_status" == "SUCCESS" && "$java_status" == "SUCCESS" ]]; then
         if diff -w -q "$native_out" "$java_out" >/dev/null; then
             log "MATCH" "  Outputs Match!"
             compare_status="MATCH"
             ((SUCCESS_MATCH++))
         else
             log "MISMATCH" "  Outputs Do Not Match"
             compare_status="MISMATCH"
             ((SUCCESS_MISMATCH++))
             # Show diff
             diff -w "$native_out" "$java_out" > "$work_dir/diff.txt"
         fi
    elif [[ "$java_status" == "SUCCESS" ]]; then
        compare_status="JAVA_ONLY"
        ((SUCCESS_JAVA_ONLY++))
    else
        compare_status="FAIL"
        # Failures are already incremented in their specific blocks
    fi
    
    add_json_item "$relative_path" "$file" "$java_status" "$native_status" "$compare_status" "$work_dir"

}

add_json_item() {
    local path="$1"
    local source_path="$2"
    local j_stat="$3"
    local n_stat="$4"
    local comp="$5"
    local w_dir="$6"
    
    JSON_ITEMS+=("{\"path\": \"$path\", \"source_path\": \"$source_path\", \"java_status\": \"$j_stat\", \"native_status\": \"$n_stat\", \"compare\": \"$comp\", \"work_dir\": \"$w_dir\"}")
}

# Counters
TOTAL_FILES=0
PROCESSED_FILES=0
SUCCESS_MATCH=0
SUCCESS_MISMATCH=0
SUCCESS_JAVA_ONLY=0
FAIL_CONVERSION=0
FAIL_COMPILE=0
FAIL_EXECUTION=0
SKIPPED_COPYBOOK=0
SKIPPED_NO_ID=0

generate_report() {
    # Calculate Success Rate
    # Success = Matches + Skipped (valid skips)
    local success_count=$((SUCCESS_MATCH + SKIPPED_COPYBOOK + SKIPPED_NO_ID))
    local success_rate=0
    if [[ $TOTAL_FILES -gt 0 ]]; then
        success_rate=$(awk "BEGIN {printf \"%.1f\", ($success_count / $TOTAL_FILES) * 100}")
    fi

    echo "{" > "$OUTPUT_DIR/report.json"
    echo "  \"summary\": {" >> "$OUTPUT_DIR/report.json"
    echo "    \"total\": $TOTAL_FILES," >> "$OUTPUT_DIR/report.json"
    echo "    \"processed\": $PROCESSED_FILES," >> "$OUTPUT_DIR/report.json"
    echo "    \"matches\": $SUCCESS_MATCH," >> "$OUTPUT_DIR/report.json"
    echo "    \"mismatches\": $SUCCESS_MISMATCH," >> "$OUTPUT_DIR/report.json"
    echo "    \"success_java_only\": $SUCCESS_JAVA_ONLY," >> "$OUTPUT_DIR/report.json"
    echo "    \"fail_conversion\": $FAIL_CONVERSION," >> "$OUTPUT_DIR/report.json"
    echo "    \"fail_compile\": $FAIL_COMPILE," >> "$OUTPUT_DIR/report.json"
    echo "    \"fail_execution\": $FAIL_EXECUTION," >> "$OUTPUT_DIR/report.json"
    echo "    \"skipped_copybook\": $SKIPPED_COPYBOOK," >> "$OUTPUT_DIR/report.json"
    echo "    \"skipped_noid\": $SKIPPED_NO_ID," >> "$OUTPUT_DIR/report.json"
    echo "    \"success_count\": $success_count," >> "$OUTPUT_DIR/report.json"
    echo "    \"success_rate\": $success_rate" >> "$OUTPUT_DIR/report.json"
    echo "  }," >> "$OUTPUT_DIR/report.json"
    echo "  \"files\": [" >> "$OUTPUT_DIR/report.json"
    local len=${#JSON_ITEMS[@]}
    for (( i=0; i<len; i++ )); do
        echo "    ${JSON_ITEMS[$i]}$([[ $i -lt $((len-1)) ]] && echo ",")" >> "$OUTPUT_DIR/report.json"
    done

    echo "  ]" >> "$OUTPUT_DIR/report.json"
    echo "}" >> "$OUTPUT_DIR/report.json"
}

# Main
main() {
    if [[ $# -lt 1 ]]; then
        echo "Usage: $0 <git-url-or-path> [output-dir]"
        exit 1
    fi
    
    local input="$1"
    OUTPUT_DIR="${2:-./cobol_output}"
    mkdir -p "$OUTPUT_DIR"
    OUTPUT_DIR=$(realpath "$OUTPUT_DIR")
    LOG_FILE="$OUTPUT_DIR/scanner.log"
    
    check_requirements
    clone_or_use_path "$input"
    setup_dependencies
    
    log "INFO" "Starting scan..."
    
    local files=()
    while IFS= read -r -d '' file; do
        files+=("$file")
    done < <(find "$SOURCE_DIR" -type f \( -iname "*.cbl" -o -iname "*.cob" -o -iname "*.cpy" \) -print0 2>/dev/null)
    
    if [[ ${#files[@]} -eq 0 ]]; then
        log "WARN" "No COBOL files found"
        exit 0
    fi
    
    for file in "${files[@]}"; do
        process_file "$file"
    done
    
    generate_report
    
    echo ""
    log "INFO" "Scan Complete. Report saved to $OUTPUT_DIR/report.json"
    log "INFO" "Summary: Matches=$SUCCESS_MATCH, Mismatches=$SUCCESS_MISMATCH, Errors=$FAIL_CONVERSION"
}

main "$@"
