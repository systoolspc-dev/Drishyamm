import { useState, useEffect, useRef } from 'react';
import { weaponDetectionService } from './weaponDetectionService';

export function useThreatFeed() {
  const [detections, setDetections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newDetectionId, setNewDetectionId] = useState(null);
  
  const previousDetectionsRef = useRef([]);

  const fetchFeed = async () => {
    const data = await weaponDetectionService.getDetections();
    
    if (data.length > previousDetectionsRef.current.length) {
      // Find the newest one
      const newest = data[0];
      if (newest && newest.id !== previousDetectionsRef.current[0]?.id) {
        setNewDetectionId(newest.id);
        // Reset after 3 seconds
        setTimeout(() => setNewDetectionId(null), 3000);
      }
    }
    
    setDetections(data);
    previousDetectionsRef.current = data;
    setLoading(false);
  };

  useEffect(() => {
    fetchFeed();
    const interval = setInterval(fetchFeed, 5000);
    return () => clearInterval(interval);
  }, []);

  return { detections, loading, newDetectionId };
}
