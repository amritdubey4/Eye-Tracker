# Eye  Tracker 

This project is an eye tracking heatmap generator that utilizes WebGazer for gaze tracking and Heatmap.js for visualizing gaze data. The application is styled using Tailwind CSS.

## Project Structure

```

├── index.html        # Main HTML document
├── css
│   └── styles.css    # CSS styles for the application
├── js
│   └── main.js       # JavaScript functionality for the application
└── README.md         # Project documentation
```

## Setup Instructions

1. **Clone the Repository**: 
   Clone this repository to your local machine using:
   ```
   git clone <repository-url>
   ```

2. **Open the Project**: 
   Navigate to the project directory:
   ```
   cd Eye Tracker
   ```

3. **Open index.html**: 
   Open `index.html` in your web browser to view the application.

## Usage

- The application will initialize WebGazer on load and start tracking gaze data.
- Follow the on-screen instructions for calibration.
- Use the provided buttons to toggle the heatmap visibility and reset data.

## External Libraries

This project uses the following external libraries:

- **WebGazer**: For gaze tracking.
- **Heatmap.js**: For generating heatmaps based on gaze data.
- **Tailwind CSS**: For styling the application.

Ensure that you have an internet connection to access these libraries via CDN links included in `index.html`.