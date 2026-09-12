#include "oniguruma.h"
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

static char g_last_error[256];
static int  g_last_error_len;

typedef struct {
    OnigRegex *regexes;
    int count;
} OnigScanner;

int onig_scanner_init(void) {
    OnigEncoding encs[] = { ONIG_ENCODING_UTF8 };
    int r = onig_initialize(encs, 1);
    if (r != ONIG_NORMAL) return r;
    onig_set_match_stack_limit_size(100000);
    g_last_error[0] = '\0';
    g_last_error_len = 0;
    return 0;
}

static void set_last_error(int code, OnigErrorInfo *einfo) {
    UChar buf[ONIG_MAX_ERROR_MESSAGE_LEN];
    int len = onig_error_code_to_str(buf, code, einfo);
    if (len > (int)sizeof(g_last_error) - 1)
        len = (int)sizeof(g_last_error) - 1;
    memcpy(g_last_error, buf, len);
    g_last_error[len] = '\0';
    g_last_error_len = len;
}

uintptr_t create_onig_scanner(
    const char *patterns_buf,
    const int  *lengths,
    int count
) {
    OnigScanner *scanner = (OnigScanner *)malloc(sizeof(OnigScanner));
    if (!scanner) return 0;

    scanner->regexes = (OnigRegex *)malloc(sizeof(OnigRegex) * count);
    if (!scanner->regexes) {
        free(scanner);
        return 0;
    }
    scanner->count = count;

    const char *p = patterns_buf;
    for (int i = 0; i < count; i++) {
        OnigErrorInfo einfo;
        int r = onig_new(
            &scanner->regexes[i],
            (const UChar *)p,
            (const UChar *)(p + lengths[i]),
            ONIG_OPTION_CAPTURE_GROUP,
            ONIG_ENCODING_UTF8,
            ONIG_SYNTAX_DEFAULT,
            &einfo
        );
        if (r != ONIG_NORMAL) {
            set_last_error(r, &einfo);
            for (int j = 0; j < i; j++)
                onig_free(scanner->regexes[j]);
            free(scanner->regexes);
            free(scanner);
            return 0;
        }
        p += lengths[i];
    }

    return (uintptr_t)scanner;
}

int find_next_match(
    uintptr_t scanner_ptr,
    const char *str, int str_len, int start_pos,
    int *result_buf, int result_buf_size,
    int options
) {
    OnigScanner *scanner = (OnigScanner *)scanner_ptr;
    OnigRegion *region = onig_region_new();
    if (!region) return -2;

    int best_idx = -1;
    int best_start = str_len + 1;
    int best_num_regs = 0;

    OnigRegion *best_region = onig_region_new();
    if (!best_region) {
        onig_region_free(region, 1);
        return -2;
    }

    for (int i = 0; i < scanner->count; i++) {
        onig_region_clear(region);

        int r = onig_search(
            scanner->regexes[i],
            (const UChar *)str,
            (const UChar *)(str + str_len),
            (const UChar *)(str + start_pos),
            (const UChar *)(str + str_len),
            region,
            (OnigOptionType)options
        );

        if (r >= 0) {
            int match_start = region->beg[0];
            if (match_start < best_start ||
                (match_start == best_start && i < best_idx)) {
                best_idx = i;
                best_start = match_start;
                best_num_regs = region->num_regs;

                onig_region_copy(best_region, region);
            }
        }
    }

    onig_region_free(region, 1);

    if (best_idx < 0) {
        onig_region_free(best_region, 1);
        return -1;
    }

    int slots_needed = 2 + best_num_regs * 2;
    if (slots_needed > result_buf_size) {
        if (result_buf_size >= 2) {
            best_num_regs = (result_buf_size - 2) / 2;
            slots_needed = 2 + best_num_regs * 2;
        } else {
            onig_region_free(best_region, 1);
            return -2;
        }
    }

    result_buf[0] = best_idx;
    result_buf[1] = best_num_regs;
    for (int i = 0; i < best_num_regs; i++) {
        result_buf[2 + i * 2]     = best_region->beg[i];
        result_buf[2 + i * 2 + 1] = best_region->end[i];
    }

    onig_region_free(best_region, 1);
    return best_num_regs;
}

void free_onig_scanner(uintptr_t scanner_ptr) {
    OnigScanner *scanner = (OnigScanner *)scanner_ptr;
    if (!scanner) return;
    for (int i = 0; i < scanner->count; i++)
        onig_free(scanner->regexes[i]);
    free(scanner->regexes);
    free(scanner);
}

int get_last_onig_error(char *buf, int buf_size) {
    int len = g_last_error_len;
    if (len > buf_size - 1)
        len = buf_size - 1;
    memcpy(buf, g_last_error, len);
    buf[len] = '\0';
    return len;
}
