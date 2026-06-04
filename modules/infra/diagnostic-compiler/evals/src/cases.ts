export interface EvalCase {
  id: string;
  title: string;
  prompt: string;
  fixtureSource: string;
  expectedStdout: string;
  requiredSourcePatterns: RegExp[];
}

export const evalCases: EvalCase[] = [
  {
    id: "hello-world",
    title: "Hello world",
    prompt: [
      "Write a single-file Zero program named hello.0.",
      "It should print exactly `hello from zero` followed by a newline.",
      "Return only the Zero source code.",
    ].join("\n"),
    fixtureSource: [
      "pub fn main(world: World) -> Void raises {",
      "    check world.out.write(\"hello from zero\\n\")",
      "}",
      "",
    ].join("\n"),
    expectedStdout: "hello from zero\n",
    requiredSourcePatterns: [
      /pub\s+fn\s+main/,
      /World/,
      /world\.out\.write/,
      /hello from zero/,
    ],
  },
  {
    id: "fibonacci",
    title: "Recursive Fibonacci",
    prompt: [
      "Write a single-file Zero program named fib.0.",
      "Define a helper `fib(n: u32) -> u32` that computes Fibonacci recursively.",
      "In `main`, call that helper to verify fib(0) through fib(10).",
      "Only when all results are correct, print exactly `fib sequence: 0 1 1 2 3 5 8 13 21 34 55` followed by a newline.",
      "Return only the Zero source code.",
    ].join("\n"),
    fixtureSource: [
      "fn fib(n: u32) -> u32 {",
      "    if n <= 1 {",
      "        return n",
      "    }",
      "    return fib(n - 1) + fib(n - 2)",
      "}",
      "",
      "pub fn main(world: World) -> Void raises {",
      "    let ok: Bool = fib(0) == 0 && fib(1) == 1 && fib(2) == 1 && fib(3) == 2 && fib(4) == 3 && fib(5) == 5 && fib(6) == 8 && fib(7) == 13 && fib(8) == 21 && fib(9) == 34 && fib(10) == 55",
      "    if ok {",
      "        check world.out.write(\"fib sequence: 0 1 1 2 3 5 8 13 21 34 55\\n\")",
      "    }",
      "}",
      "",
    ].join("\n"),
    expectedStdout: "fib sequence: 0 1 1 2 3 5 8 13 21 34 55\n",
    requiredSourcePatterns: [
      /fn\s+fib\s*\(\s*n\s*:\s*u32\s*\)\s*->\s*u32/,
      /fib\s*\(\s*n\s*-\s*1\s*\)\s*\+\s*fib\s*\(\s*n\s*-\s*2\s*\)/,
      /fib\s*\(\s*0(?:_u32)?\s*\)\s*==\s*0/,
      /fib\s*\(\s*1(?:_u32)?\s*\)\s*==\s*1/,
      /fib\s*\(\s*2(?:_u32)?\s*\)\s*==\s*1/,
      /fib\s*\(\s*3(?:_u32)?\s*\)\s*==\s*2/,
      /fib\s*\(\s*4(?:_u32)?\s*\)\s*==\s*3/,
      /fib\s*\(\s*5(?:_u32)?\s*\)\s*==\s*5/,
      /fib\s*\(\s*6(?:_u32)?\s*\)\s*==\s*8/,
      /fib\s*\(\s*7(?:_u32)?\s*\)\s*==\s*13/,
      /fib\s*\(\s*8(?:_u32)?\s*\)\s*==\s*21/,
      /fib\s*\(\s*9(?:_u32)?\s*\)\s*==\s*34/,
      /fib\s*\(\s*10(?:_u32)?\s*\)\s*==\s*55/,
      /pub\s+fn\s+main/,
      /World/,
      /world\.out\.write/,
      /fib sequence: 0 1 1 2 3 5 8 13 21 34 55/,
    ],
  },
];

export function findEvalCase(id: string): EvalCase | undefined {
  return evalCases.find((evalCase) => evalCase.id === id);
}
