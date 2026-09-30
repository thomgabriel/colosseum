declare module 'javascript-lp-solver' {
  export type LpModel = {
    optimize: string;
    opType: 'max' | 'min';
    constraints: Record<string, { max?: number; min?: number; equal?: number }>;
    variables: Record<string, Record<string, number>>;
  };
  export type LpResult = { feasible: boolean; bounded: boolean; result: number } & Record<
    string,
    number | boolean
  >;
  const solver: { Solve(model: LpModel): LpResult };
  export default solver;
}
