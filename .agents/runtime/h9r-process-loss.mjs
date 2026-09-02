export function buildWorkerProcessLossCommand(worker) {
  const hostPid = Number(worker?.hostPid);
  const image = String(worker?.image ?? "").trim();
  const restartPolicy = String(worker?.restartPolicy ?? "").trim();
  if (!worker?.running) throw new Error("h9r_worker_not_running_before_process_loss");
  if (!Number.isInteger(hostPid) || hostPid <= 1) throw new Error(`h9r_worker_host_pid_invalid:${worker?.hostPid ?? "missing"}`);
  if (!image) throw new Error("h9r_worker_image_missing");
  if (!["always", "unless-stopped"].includes(restartPolicy)) {
    throw new Error(`h9r_worker_restart_policy_invalid:${restartPolicy || "missing"}`);
  }
  return [
    "run", "--rm", "--pull=never", "--network=none", "--read-only",
    "--pid=host", "--userns=host", "--cap-drop=ALL", "--cap-add=KILL", "--entrypoint", "sh", image,
    "-lc", `kill -KILL ${hostPid}`,
  ];
}
