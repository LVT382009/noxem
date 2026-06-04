#ifndef ZERO_TARGET_CONDITIONAL_H
#define ZERO_TARGET_CONDITIONAL_H

#if defined(_WIN32) && !defined(__linux__)
int zero_c_windows_add(int left, int right);
#elif defined(__linux__)
int zero_c_linux_add(int left, int right);
#else
int zero_c_fallback_add(int left, int right);
#endif

#ifndef _WIN32
int zero_c_not_windows(int value);
#endif

#ifdef __aarch64__
int zero_c_arm64_only(int value);
#endif

#endif
