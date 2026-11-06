import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { shinobiService } from '@/core/services/shinobi';
import { cameraGroupService } from '@/core/services/cameraGroup';
import { getGroupRecordings, getCameraRecordings, getPlaybackUrl, getDownloadUrl } from '@/core/services/recordings';

// ─── Query Keys ─────────────────────────────────────────────────────────────
export const queryKeys = {
  cameras: ['cameras'],
  camera: (id) => ['cameras', id],
  groups: ['groups'],
  group: (id) => ['groups', id],
  groupRecordings: (groupId, date) => ['recordings', 'group', groupId, date],
  cameraRecordings: (groupId, monitorId, date) => ['recordings', 'camera', groupId, monitorId, date],
  shinobiRecordings: (monitorId, start, end) => ['shinobi-recordings', monitorId, start, end],
};

// ─── Cameras (Shinobi) ─────────────────────────────────────────────────────
export function useCameras(options = {}) {
  return useQuery({
    queryKey: queryKeys.cameras,
    queryFn: () => shinobiService.getCameras(),
    staleTime: 30_000,
    ...options,
  });
}

export function useCamera(monitorId, options = {}) {
  return useQuery({
    queryKey: queryKeys.camera(monitorId),
    queryFn: () => shinobiService.getCamera(monitorId),
    enabled: !!monitorId,
    staleTime: 30_000,
    ...options,
  });
}

// ─── Camera Groups ──────────────────────────────────────────────────────────
export function useGroups(options = {}) {
  return useQuery({
    queryKey: queryKeys.groups,
    queryFn: () => cameraGroupService.getGroups(),
    staleTime: 15_000,
    ...options,
  });
}

export function useGroup(groupId, options = {}) {
  return useQuery({
    queryKey: queryKeys.group(groupId),
    queryFn: () => cameraGroupService.getGroup(groupId),
    enabled: !!groupId,
    staleTime: 15_000,
    ...options,
  });
}

// ─── Camera Mutations ───────────────────────────────────────────────────────
export function useAddCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cameraData) => shinobiService.addCamera(cameraData),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cameras }),
  });
}

export function useUpdateCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ monitorId, data }) => shinobiService.updateCamera(monitorId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cameras }),
  });
}

export function useDeleteCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (monitorId) => shinobiService.deleteCamera(monitorId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.cameras }),
  });
}

// ─── Group Mutations ────────────────────────────────────────────────────────
export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => cameraGroupService.createGroup(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.groups });
      qc.invalidateQueries({ queryKey: ['licence-usage'] }); // camera licences used
    },
  });
}

export function useUpdateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, body }) => cameraGroupService.updateGroup(groupId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.groups });
      qc.invalidateQueries({ queryKey: ['licence-usage'] }); // camera licences used
    },
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupId) => cameraGroupService.deleteGroup(groupId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.groups });
      qc.invalidateQueries({ queryKey: ['licence-usage'] }); // camera licences used
    },
  });
}

export function useSyncGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupId) => cameraGroupService.syncGroup(groupId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.groups }),
  });
}

export function useDeleteGroupCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, monitorId }) =>
      cameraGroupService.deleteCameraFromGroup(groupId, monitorId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.groups });
      qc.invalidateQueries({ queryKey: ['licence-usage'] }); // camera licences used
    },
  });
}

// ─── Recording retention ────────────────────────────────────────────────────
export function useSetGroupRetention() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, retentionDays }) =>
      cameraGroupService.setGroupRetention(groupId, retentionDays),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.groups }),
  });
}

export function useSetCameraRetention() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, monitorId, retentionDays }) =>
      cameraGroupService.setCameraRetention(groupId, monitorId, retentionDays),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.groups }),
  });
}

export function useSetCamerasRetentionBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, monitorIds, retentionDays }) =>
      cameraGroupService.setCamerasRetentionBulk(groupId, monitorIds, retentionDays),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.groups }),
  });
}

// ─── Default stream quality ─────────────────────────────────────────────────
export function useSetGroupQuality() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, streamQuality }) => cameraGroupService.setGroupQuality(groupId, streamQuality),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.groups }),
  });
}
export function useSetCameraQuality() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, monitorId, streamQuality }) =>
      cameraGroupService.setCameraQuality(groupId, monitorId, streamQuality),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.groups }),
  });
}
export function useSetCamerasQualityBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, monitorIds, streamQuality }) =>
      cameraGroupService.setCamerasQualityBulk(groupId, monitorIds, streamQuality),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.groups }),
  });
}

// ─── Recordings ─────────────────────────────────────────────────────────────
export function useGroupRecordings(groupId, date, options = {}) {
  return useQuery({
    queryKey: queryKeys.groupRecordings(groupId, date),
    queryFn: () => cameraGroupService.getGroupRecordings(groupId, date || null),
    enabled: !!groupId,
    staleTime: 60_000,
    ...options,
  });
}

export function useCameraRecordings(groupId, monitorId, date, options = {}) {
  return useQuery({
    queryKey: queryKeys.cameraRecordings(groupId, monitorId, date),
    queryFn: () => getCameraRecordings(groupId, monitorId, date || null),
    enabled: !!groupId && !!monitorId,
    staleTime: 60_000,
    ...options,
  });
}

export function useShinobiRecordings(monitorId, start, end, options = {}) {
  return useQuery({
    queryKey: queryKeys.shinobiRecordings(monitorId, start, end),
    queryFn: () => shinobiService.getRecordings(monitorId, start, end),
    enabled: !!monitorId && !!start && !!end,
    staleTime: 60_000,
    ...options,
  });
}
