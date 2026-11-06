import os
from ultralytics import YOLO

def main():
    # Dataset path
    dataset_path = r"c:\projects\vehicle color\Color Vehicle.v1i.folder"
    
    # Verify dataset exists
    if not os.path.exists(dataset_path):
        print(f"Error: Dataset path '{dataset_path}' does not exist.")
        return

    print("Initializing YOLO11 classification model...")
    # Load a pre-trained YOLO11 classification model (nano version)
    # You can change 'yolo11n-cls.pt' to 'yolo11s-cls.pt' or larger for better accuracy
    model = YOLO("yolo11n-cls.pt")

    print("Starting training...")
    # Train the model
    results = model.train(
        data=dataset_path,
        epochs=50,      # Number of training epochs (adjust as needed)
        imgsz=640,      # Image size for classification
        batch=16,       # Batch size
        project="vehicle_color_detection", # Output directory for results
        name="run_1",   # Name of the current training run
        device="0"
    )
    
    print("Training complete! Model saved in the 'vehicle_color_detection/run_1/weights' directory.")

if __name__ == "__main__":
    main()
