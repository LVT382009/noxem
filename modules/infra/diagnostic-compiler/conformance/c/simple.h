#define ZERO_C_ANSWER 42

typedef int zero_c_int;

typedef struct zero_c_point {
  int x;
  int y;
} zero_c_point;

enum zero_c_color {
  ZERO_C_RED = 1,
  ZERO_C_BLUE = 2
};

int zero_c_add(int a, int b);
