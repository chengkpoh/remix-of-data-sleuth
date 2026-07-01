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
  runHealthCheck: (params) => ipcRenderer.invoke("erp:runHealthCheck", params || {}),
  cancelHealthCheck: () => ipcRenderer.invoke("erp:cancelHealthCheck"),
  onHealthCheckProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("erp:healthCheckProgress", listener);
    return () => ipcRenderer.removeListener("erp:healthCheckProgress", listener);
  },
  getForeignKeys: () => ipcRenderer.invoke("erp:getForeignKeys"),
  runDataExplorerQuery: (spec) => ipcRenderer.invoke("erp:runDataExplorerQuery", spec),
});
