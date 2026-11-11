// Browser stand-in for `node:process`; the sessions plugin only asks for a pid
// to label its lease holder and probes other pids it never meets here.
const process = {
  pid: 1,
  kill: (_pid: number, _signal?: number): boolean => true,
}
export default process
