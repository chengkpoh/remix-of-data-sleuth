const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("erp", {
  isElectron: true,
  test: (cfg) => ipcRenderer.invoke("erp:test", cfg),
  connect: (cfg) => ipcRenderer.invoke("erp:connect", cfg),
  disconnect: () => ipcRenderer.invoke("erp:disconnect"),
  getSchema: () => ipcRenderer.invoke("erp:getSchema"),
  search: (params) => ipcRenderer.invoke("erp:search", params),
  cancelSearch: () => ipcRenderer.invoke("erp:cancelSearch"),
  getRecord: (params) => ipcRenderer.invoke("erp:getRecord", params),
  onSearchProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("erp:searchProgress", listener);
    return () => ipcRenderer.removeListener("erp:searchProgress", listener);
  },
  getServerInfo: () => ipcRenderer.invoke("erp:getServerInfo"),
  getDatabaseSize: () => ipcRenderer.invoke("erp:getDatabaseSize"),
  getLogSize: () => ipcRenderer.invoke("erp:getLogSize"),
  shrinkDatabase: () => ipcRenderer.invoke("erp:shrinkDatabase"),
  getFragmentation: (params) => ipcRenderer.invoke("erp:getFragmentation", params || {}),
  runIndexMaintenance: (params) => ipcRenderer.invoke("erp:runIndexMaintenance", params || {}),
  cancelMaintenance: () => ipcRenderer.invoke("erp:cancelMaintenance"),
  onMaintenanceProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("erp:maintenanceProgress", listener);
    return () => ipcRenderer.removeListener("erp:maintenanceProgress", listener);
  },
  getTableColumns: (params) => ipcRenderer.invoke("erp:getTableColumns", params),
  getColumnDependencies: (params) => ipcRenderer.invoke("erp:getColumnDependencies", params),
  executeAlterStatements: (params) => ipcRenderer.invoke("erp:executeAlterStatements", params),

  getForeignKeys: () => ipcRenderer.invoke("erp:getForeignKeys"),
  runDataExplorerQuery: (spec) => ipcRenderer.invoke("erp:runDataExplorerQuery", spec),

  // ✅ Data Explorer 流式查询 — 大数据集不卡 UI
  streamDataExplorerQuery: (reqId, spec) =>
    ipcRenderer.send("erp:dataExplorer:stream", { reqId, spec }),

  onDataExplorerStart: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("erp:dataExplorer:start", listener);
    return () => ipcRenderer.removeListener("erp:dataExplorer:start", listener);
  },
  onDataExplorerBatch: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("erp:dataExplorer:batch", listener);
    return () => ipcRenderer.removeListener("erp:dataExplorer:batch", listener);
  },
  onDataExplorerDone: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("erp:dataExplorer:done", listener);
    return () => ipcRenderer.removeListener("erp:dataExplorer:done", listener);
  },
  onDataExplorerError: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("erp:dataExplorer:error", listener);
    return () => ipcRenderer.removeListener("erp:dataExplorer:error", listener);
  },
});