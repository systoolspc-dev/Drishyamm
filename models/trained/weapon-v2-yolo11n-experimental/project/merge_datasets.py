import os
import shutil
import yaml
import uuid
from pathlib import Path

def load_yaml(path):
    with open(path, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f)

def save_yaml(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        yaml.safe_dump(data, f, sort_keys=False)

def main():
    base_dir = Path(r"c:\projects\Weapon Detection New")
    ds1_dir = base_dir / "Weapon Detection.v1i.yolo26"
    ds2_dir = base_dir / "non_weapons.v1i.yolo26"
    out_dir = base_dir / "Combined_Dataset"

    # Load classes
    ds1_yaml = load_yaml(ds1_dir / "data.yaml")
    ds2_yaml = load_yaml(ds2_dir / "data.yaml")

    ds1_names = ds1_yaml.get('names', [])
    ds2_names = ds2_yaml.get('names', [])

    # Create combined class list (preserving order as much as possible)
    combined_names = list(ds1_names)
    for name in ds2_names:
        if name not in combined_names:
            combined_names.append(name)

    # Create mapping from old indices to new indices
    ds1_mapping = {i: combined_names.index(name) for i, name in enumerate(ds1_names)}
    ds2_mapping = {i: combined_names.index(name) for i, name in enumerate(ds2_names)}

    print(f"Total combined classes: {len(combined_names)}")
    
    # Setup output directory
    splits = ['train', 'valid', 'test']
    for split in splits:
        os.makedirs(out_dir / split / "images", exist_ok=True)
        os.makedirs(out_dir / split / "labels", exist_ok=True)

    def process_split(src_dir, mapping, prefix):
        for split in splits:
            images_dir = src_dir / split / "images"
            labels_dir = src_dir / split / "labels"
            if not images_dir.exists():
                continue
                
            for img_file in images_dir.glob("*.*"):
                if img_file.is_file():
                    # Generate unique name to avoid conflicts
                    uid = uuid.uuid4().hex[:8]
                    new_img_name = f"{prefix}_{uid}_{img_file.name}"
                    new_img_path = out_dir / split / "images" / new_img_name
                    
                    # Copy image
                    shutil.copy2(img_file, new_img_path)
                    
                    # Process label if exists
                    label_file = labels_dir / f"{img_file.stem}.txt"
                    new_label_path = out_dir / split / "labels" / f"{Path(new_img_name).stem}.txt"
                    
                    if label_file.exists():
                        with open(label_file, 'r', encoding='utf-8') as lf:
                            lines = lf.readlines()
                        
                        new_lines = []
                        for line in lines:
                            parts = line.strip().split()
                            if len(parts) >= 5:
                                old_class_id = int(parts[0])
                                new_class_id = mapping.get(old_class_id, -1)
                                if new_class_id != -1:
                                    parts[0] = str(new_class_id)
                                    new_lines.append(" ".join(parts) + "\n")
                                    
                        with open(new_label_path, 'w', encoding='utf-8') as out_lf:
                            out_lf.writelines(new_lines)

    print("Processing Dataset 1 (Weapons)...")
    process_split(ds1_dir, ds1_mapping, "wep")
    
    print("Processing Dataset 2 (Non-weapons)...")
    process_split(ds2_dir, ds2_mapping, "nw")

    # Generate output yaml
    out_yaml = {
        'train': '../train/images',
        'val': '../valid/images',
        'test': '../test/images',
        'nc': len(combined_names),
        'names': combined_names
    }
    save_yaml(out_dir / "data.yaml", out_yaml)
    print("Merge complete!")

if __name__ == "__main__":
    main()
